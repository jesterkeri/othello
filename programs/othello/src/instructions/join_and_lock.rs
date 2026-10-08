//! `join_and_lock` (T09, SPEC §5).
//!
//! This is the member's consent. ADR-003 and FLOWS D3: the creator named who is
//! in the circle and in what order, and nothing binds a member until they sign
//! this transaction, which moves two things at once, their stock and their
//! guarantee, and tells them both amounts first.
//!
//! The seat is found by SCANNING `circle.members`, never passed in. A `turn`
//! argument would let a joiner claim someone else's position in the payout
//! order, which is the whole economic ordering of the circle.
//!
//! ## Why the vaults are ATAs
//!
//! T08 tried creating the circle's vaults with Anchor's `init`, which allocates
//! the base 165 bytes of a token account. A real xStock refused it:
//!
//!   Program log: Instruction: InitializeAccount3
//!   Program log: Warning: Mint has a permanent delegate, so tokens in this
//!                account may be seized at any time
//!   Program log: Error: InvalidAccountData
//!
//! A Token-2022 account for a mint carrying extensions needs more than 165
//! bytes, and the account's own extension set depends on the mint's. The
//! Associated Token program computes that length itself, so every token account
//! here is an ATA and the sizing problem belongs to the program that knows the
//! answer. This is KNOWN-LIMITS L7 met head-on rather than assumed away.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::MemberJoined;
use crate::instructions::usdc_collateral::{
    lock_usdc, read_collateral_vault, read_seat_collateral, require_approved_usdc,
    require_usdc_enabled, SeatRead, UsdcLock, VaultRead,
};
use crate::state::{Circle, CircleStatus, Member, PriceFeed};
use crate::valuation::value_position;

#[derive(Accounts)]
pub struct JoinAndLock<'info> {
    /// The joining member. Pays for their own Member account and for their USDC
    /// ATA if it does not exist yet, so `release_pot` never has to.
    #[account(mut)]
    pub wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = stock_mint,
        has_one = usdc_mint,
        has_one = price_feed,
    )]
    pub circle: Box<Account<'info, Circle>>,

    #[account(
        init,
        payer = wallet,
        space = 8 + Member::INIT_SPACE,
        seeds = [Member::SEED, circle.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub member: Box<Account<'info, Member>>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Bound to `stock_mint` by its own seeds, so "the right feed" is structural.
    #[account(
        seeds = [PriceFeed::SEED, stock_mint.key().as_ref()],
        bump = price_feed.bump,
        has_one = stock_mint,
    )]
    pub price_feed: Box<Account<'info, PriceFeed>>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = wallet,
        associated_token::token_program = stock_token_program,
    )]
    pub member_stock_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// SPEC §5 creates this here if it is missing, with the member paying, "so
    /// release_pot never has to". A pot that cannot be delivered because the
    /// recipient has no USDC account would pause a circle for a reason that has
    /// nothing to do with anyone's collateral.
    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = usdc_mint,
        associated_token::authority = wallet,
        associated_token::token_program = usdc_token_program,
    )]
    pub member_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The circle's stock vault. Created on the first join and owned by the
    /// circle PDA, so no human signature can move it.
    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = stock_mint,
        associated_token::authority = circle,
        associated_token::token_program = stock_token_program,
    )]
    pub circle_stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = usdc_mint,
        associated_token::authority = circle,
        associated_token::token_program = usdc_token_program,
    )]
    pub circle_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The stock is Token-2022 and USDC is SPL Token, so the two are separate
    /// accounts rather than one shared program.
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// `join_and_lock_v2(stock_raw, usdc_raw)` (SPEC §4b): `join_and_lock`'s accounts, with the member's stock account
/// created if missing (a USDC-only join locks no stock), plus the seat's SeatCollateral, the circle's collateral
/// vault and the feature marker, each a raw account read as a state union.
#[derive(Accounts)]
pub struct JoinAndLockV2<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = stock_mint,
        has_one = usdc_mint,
        has_one = price_feed,
    )]
    pub circle: Box<Account<'info, Circle>>,

    #[account(
        init,
        payer = wallet,
        space = 8 + Member::INIT_SPACE,
        seeds = [Member::SEED, circle.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub member: Box<Account<'info, Member>>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Read only when stock_raw > 0 (SPEC §4b: a USDC-only seat needs no price).
    #[account(
        seeds = [PriceFeed::SEED, stock_mint.key().as_ref()],
        bump = price_feed.bump,
        has_one = stock_mint,
    )]
    pub price_feed: Box<Account<'info, PriceFeed>>,

    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = stock_mint,
        associated_token::authority = wallet,
        associated_token::token_program = stock_token_program,
    )]
    pub member_stock_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = usdc_mint,
        associated_token::authority = wallet,
        associated_token::token_program = usdc_token_program,
    )]
    pub member_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = stock_mint,
        associated_token::authority = circle,
        associated_token::token_program = stock_token_program,
    )]
    pub circle_stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = usdc_mint,
        associated_token::authority = circle,
        associated_token::token_program = usdc_token_program,
    )]
    pub circle_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: the seat's SeatCollateral as a state union (usdc_collateral::read_seat_collateral); created by lock_usdc
    /// when usdc_raw > 0.
    #[account(mut)]
    pub seat_collateral: UncheckedAccount<'info>,

    /// CHECK: the circle's collateral vault as a state union (usdc_collateral::read_collateral_vault); created by
    /// lock_usdc when usdc_raw > 0.
    #[account(mut)]
    pub collateral_vault: UncheckedAccount<'info>,

    /// CHECK: the feature marker; required only when usdc_raw > 0 (usdc_collateral::require_usdc_enabled).
    pub features: UncheckedAccount<'info>,

    pub stock_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// The seat this wallet was named for, or `not_a_member`.
///
/// Scanning is the point: the turn is the creator's decision, recorded at
/// create time, and no argument to this instruction can move it.
fn seat_of(circle: &Circle, wallet: &Pubkey) -> Result<u8> {
    for turn in 0..circle.n as usize {
        if circle.members[turn] == *wallet {
            return Ok(turn as u8);
        }
    }
    err!(OthelloError::NotAMember)
}

pub fn handle_join_and_lock(mut ctx: Context<JoinAndLock>, stock_raw: u64) -> Result<()> {
    let a = &mut ctx.accounts;
    join(
        Join {
            wallet: &a.wallet,
            circle: &mut a.circle,
            member: &mut a.member,
            member_bump: ctx.bumps.member,
            stock_mint: &a.stock_mint,
            usdc_mint: &a.usdc_mint,
            price_feed: &a.price_feed,
            member_stock_ata: &a.member_stock_ata,
            member_usdc_ata: &a.member_usdc_ata,
            circle_stock_vault: &a.circle_stock_vault,
            circle_usdc_vault: &a.circle_usdc_vault,
            stock_token_program: &a.stock_token_program,
            usdc_token_program: &a.usdc_token_program,
        },
        stock_raw,
        None,
    )
}

/// SPEC §4b. With `usdc_raw = 0` it is `join_and_lock` (no marker needed), except that a seat may lock no stock only
/// if it locks USDC, and the price is read only when it locks stock.
pub fn handle_join_and_lock_v2(
    mut ctx: Context<JoinAndLockV2>,
    stock_raw: u64,
    usdc_raw: u64,
) -> Result<()> {
    let a = &mut ctx.accounts;
    let wallet = a.wallet.to_account_info();
    let circle_info = a.circle.to_account_info();
    let seat_collateral = a.seat_collateral.to_account_info();
    let collateral_vault = a.collateral_vault.to_account_info();
    let features = a.features.to_account_info();
    let usdc_token_program = a.usdc_token_program.to_account_info();
    let system_program = a.system_program.to_account_info();
    join(
        Join {
            wallet: &a.wallet,
            circle: &mut a.circle,
            member: &mut a.member,
            member_bump: ctx.bumps.member,
            stock_mint: &a.stock_mint,
            usdc_mint: &a.usdc_mint,
            price_feed: &a.price_feed,
            member_stock_ata: &a.member_stock_ata,
            member_usdc_ata: &a.member_usdc_ata,
            circle_stock_vault: &a.circle_stock_vault,
            circle_usdc_vault: &a.circle_usdc_vault,
            stock_token_program: &a.stock_token_program,
            usdc_token_program: &a.usdc_token_program,
        },
        stock_raw,
        Some(UsdcJoin {
            usdc_raw,
            seat_collateral: &seat_collateral,
            collateral_vault: &collateral_vault,
            features: &features,
            wallet: &wallet,
            circle: &circle_info,
            usdc_token_program: &usdc_token_program,
            system_program: &system_program,
        }),
    )
}

/// The accounts both joins share.
struct Join<'a, 'info> {
    wallet: &'a Signer<'info>,
    circle: &'a mut Box<Account<'info, Circle>>,
    member: &'a mut Box<Account<'info, Member>>,
    member_bump: u8,
    stock_mint: &'a InterfaceAccount<'info, Mint>,
    usdc_mint: &'a InterfaceAccount<'info, Mint>,
    price_feed: &'a Account<'info, PriceFeed>,
    member_stock_ata: &'a InterfaceAccount<'info, TokenAccount>,
    member_usdc_ata: &'a InterfaceAccount<'info, TokenAccount>,
    circle_stock_vault: &'a InterfaceAccount<'info, TokenAccount>,
    circle_usdc_vault: &'a InterfaceAccount<'info, TokenAccount>,
    stock_token_program: &'a Interface<'info, TokenInterface>,
    usdc_token_program: &'a Interface<'info, TokenInterface>,
}

/// What only join_and_lock_v2 carries.
struct UsdcJoin<'a, 'info> {
    usdc_raw: u64,
    seat_collateral: &'a AccountInfo<'info>,
    collateral_vault: &'a AccountInfo<'info>,
    features: &'a AccountInfo<'info>,
    wallet: &'a AccountInfo<'info>,
    circle: &'a AccountInfo<'info>,
    usdc_token_program: &'a AccountInfo<'info>,
    system_program: &'a AccountInfo<'info>,
}

/// One join. `usdc` is None for `join_and_lock`, which then does exactly what it did before USDC collateral.
fn join<'a, 'info>(
    j: Join<'a, 'info>,
    stock_raw: u64,
    usdc: Option<UsdcJoin<'a, 'info>>,
) -> Result<()> {
    let circle = &j.circle;

    require!(
        circle.status == CircleStatus::Forming,
        OthelloError::CircleNotForming
    );

    let turn = seat_of(circle, &j.wallet.key())?;

    // A second join is stopped by the Member PDA's `init`, which Anchor runs
    // during account validation, before this handler body. So there is no
    // bitmap check here: one would be unreachable, and an unreachable guard
    // reads like a live one to the next person. SPEC §5 names no
    // `already_joined` code, and FLOWS §8 has no row for it, so nothing is
    // owed a friendlier refusal than the one the runtime already gives.

    // SPEC §4b: the USDC side, checked before any valuation or transfer. Both unions are read even for a stock-only
    // v2 join, so a wrong account refuses rather than being ignored, and the seat's H counts any USDC already
    // locked behind it.
    let usdc_raw = usdc.as_ref().map_or(0, |u| u.usdc_raw);
    // Each is read ONCE and the reads are passed to lock_usdc (NFR-3: every address search costs compute).
    let reads: Option<(SeatRead, VaultRead)> = match &usdc {
        None => None,
        Some(u) => {
            require!(
                stock_raw.checked_add(u.usdc_raw).is_some_and(|t| t > 0),
                OthelloError::InvalidParams
            );
            let seat = read_seat_collateral(u.seat_collateral, &circle.key(), &j.wallet.key())?;
            let vault = read_collateral_vault(u.collateral_vault, &circle.key())?;
            if u.usdc_raw > 0 {
                require_usdc_enabled(u.features)?;
                require_approved_usdc(circle, &j.usdc_token_program.key())?;
            }
            Some((seat, vault))
        }
    };
    let usdc_already = reads.as_ref().map_or(0, |(seat, _)| seat.usdc_locked);

    // SPEC §5: H(stock_raw) >= min_stock_cover, with the price fresh and the
    // stamp matching the mint. value_position enforces all three, so a stale or
    // repricing feed refuses the join rather than valuing it wrongly. Joining
    // during Repricing is exactly what D5 forbids, and the demo depends on it:
    // every member joins BEFORE the split is scheduled.
    // SPEC §4b: a v2 join that locks no stock reads no price; its stock part is exactly 0. join_and_lock reads the
    // price whatever stock_raw is, as it always has.
    let now = Clock::get()?.unix_timestamp;
    let stock_h = if stock_raw > 0 || usdc.is_none() {
        let mint_data = j.stock_mint.to_account_info();
        let mint_data = mint_data.try_borrow_data()?;
        value_position(
            j.price_feed,
            &mint_data,
            stock_raw,
            circle.haircut_bps,
            now,
            circle.max_price_age,
        )?
        .h
    } else {
        0
    };
    // USDC counts at face value, no haircut (SPEC §4b).
    let cover = stock_h
        .checked_add(usdc_already)
        .and_then(|h| h.checked_add(usdc_raw))
        .ok_or(OthelloError::ValuationOverflow)?;

    require!(
        cover >= circle.min_stock_cover,
        OthelloError::CollateralBelowMinimum
    );

    // Pre-checked so the refusal carries SPEC §5's `insufficient_balance`
    // rather than the token program's own error, which the UI cannot map to
    // copy. FLOWS §8: "You need {x} more {token}".
    require!(
        j.member_stock_ata.amount >= stock_raw,
        OthelloError::InsufficientBalance
    );
    let usdc_needed = circle
        .guarantee_per_member
        .checked_add(usdc_raw)
        .ok_or(OthelloError::ValuationOverflow)?;
    require!(
        j.member_usdc_ata.amount >= usdc_needed,
        OthelloError::InsufficientBalance
    );

    // Both moves are the member's own signature. Nothing here is a PDA
    // transfer, so a member's tokens can only leave on their own authority.
    if stock_raw > 0 || usdc.is_none() {
        transfer_checked(
            CpiContext::new(
                j.stock_token_program.key(),
                TransferChecked {
                    from: j.member_stock_ata.to_account_info(),
                    mint: j.stock_mint.to_account_info(),
                    to: j.circle_stock_vault.to_account_info(),
                    authority: j.wallet.to_account_info(),
                },
            ),
            stock_raw,
            j.stock_mint.decimals,
        )?;
    }

    transfer_checked(
        CpiContext::new(
            j.usdc_token_program.key(),
            TransferChecked {
                from: j.member_usdc_ata.to_account_info(),
                mint: j.usdc_mint.to_account_info(),
                to: j.circle_usdc_vault.to_account_info(),
                authority: j.wallet.to_account_info(),
            },
        ),
        circle.guarantee_per_member,
        j.usdc_mint.decimals,
    )?;

    // SPEC §4b: the USDC collateral, on top of the guarantee, into the collateral vault (created if absent), and
    // the seat's SeatCollateral (created if absent).
    if let (Some(u), Some((seat, vault))) = (&usdc, &reads) {
        if u.usdc_raw > 0 {
            lock_usdc(
                &UsdcLock {
                    payer: u.wallet,
                    circle: u.circle,
                    wallet: j.wallet.key(),
                    seat_collateral: u.seat_collateral,
                    collateral_vault: u.collateral_vault,
                    usdc_mint: j.usdc_mint,
                    member_usdc_ata: j.member_usdc_ata,
                    usdc_token_program: u.usdc_token_program,
                    system_program: u.system_program,
                },
                u.usdc_raw,
                seat,
                vault,
            )?;
        }
    }

    let guarantee = circle.guarantee_per_member;
    let circle = j.circle;

    let member = j.member;
    member.circle = circle.key();
    member.wallet = j.wallet.key();
    member.turn = turn;
    member.bump = j.member_bump;
    member.stock_raw = stock_raw;
    member.guarantee = guarantee;
    member.top_ups = 0;
    member.forfeited = 0;
    member.rounds_paid = 0;
    member.allocated = 0;
    // O_i is zero until this member has received, so coverage saturates from
    // the start rather than reading as 0% (SPEC.md:70).
    member.last_coverage_bps = crate::gate::COVERAGE_BPS_NOT_A_RATIO;

    circle.joined_bitmap |= 1u8 << turn;
    // Checked, not saturating: a reserve that silently stopped growing would
    // make the peak-guarantee check a lie.
    circle.reserve_total = circle
        .reserve_total
        .checked_add(guarantee)
        .ok_or(OthelloError::ValuationOverflow)?;
    circle.deposits_total = circle
        .deposits_total
        .checked_add(guarantee)
        .ok_or(OthelloError::ValuationOverflow)?;

    emit!(MemberJoined {
        circle: circle.key(),
        member: member.key(),
        wallet: member.wallet,
        turn,
        stock_raw,
        stock_cover: cover,
        guarantee,
        joined_bitmap: circle.joined_bitmap,
        usdc_raw,
    });

    Ok(())
}
