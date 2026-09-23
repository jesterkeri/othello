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

pub fn handle_join_and_lock(ctx: Context<JoinAndLock>, stock_raw: u64) -> Result<()> {
    let circle = &ctx.accounts.circle;

    require!(
        circle.status == CircleStatus::Forming,
        OthelloError::CircleNotForming
    );

    let turn = seat_of(circle, &ctx.accounts.wallet.key())?;

    // A second join is stopped by the Member PDA's `init`, which Anchor runs
    // during account validation, before this handler body. So there is no
    // bitmap check here: one would be unreachable, and an unreachable guard
    // reads like a live one to the next person. SPEC §5 names no
    // `already_joined` code, and FLOWS §8 has no row for it, so nothing is
    // owed a friendlier refusal than the one the runtime already gives.

    // SPEC §5: H(stock_raw) >= min_stock_cover, with the price fresh and the
    // stamp matching the mint. value_position enforces all three, so a stale or
    // repricing feed refuses the join rather than valuing it wrongly. Joining
    // during Repricing is exactly what D5 forbids, and the demo depends on it:
    // every member joins BEFORE the split is scheduled.
    let now = Clock::get()?.unix_timestamp;
    let valuation = {
        let mint_data = ctx.accounts.stock_mint.to_account_info();
        let mint_data = mint_data.try_borrow_data()?;
        value_position(
            &ctx.accounts.price_feed,
            &mint_data,
            stock_raw,
            circle.haircut_bps,
            now,
            circle.max_price_age,
        )?
    };

    require!(
        valuation.h >= circle.min_stock_cover,
        OthelloError::CollateralBelowMinimum
    );

    // Pre-checked so the refusal carries SPEC §5's `insufficient_balance`
    // rather than the token program's own error, which the UI cannot map to
    // copy. FLOWS §8: "You need {x} more {token}".
    require!(
        ctx.accounts.member_stock_ata.amount >= stock_raw,
        OthelloError::InsufficientBalance
    );
    require!(
        ctx.accounts.member_usdc_ata.amount >= circle.guarantee_per_member,
        OthelloError::InsufficientBalance
    );

    // Both moves are the member's own signature. Nothing here is a PDA
    // transfer, so a member's tokens can only leave on their own authority.
    transfer_checked(
        CpiContext::new(
            ctx.accounts.stock_token_program.key(),
            TransferChecked {
                from: ctx.accounts.member_stock_ata.to_account_info(),
                mint: ctx.accounts.stock_mint.to_account_info(),
                to: ctx.accounts.circle_stock_vault.to_account_info(),
                authority: ctx.accounts.wallet.to_account_info(),
            },
        ),
        stock_raw,
        ctx.accounts.stock_mint.decimals,
    )?;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.usdc_token_program.key(),
            TransferChecked {
                from: ctx.accounts.member_usdc_ata.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.circle_usdc_vault.to_account_info(),
                authority: ctx.accounts.wallet.to_account_info(),
            },
        ),
        circle.guarantee_per_member,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let guarantee = circle.guarantee_per_member;
    let circle = &mut ctx.accounts.circle;

    let member = &mut ctx.accounts.member;
    member.circle = circle.key();
    member.wallet = ctx.accounts.wallet.key();
    member.turn = turn;
    member.bump = ctx.bumps.member;
    member.stock_raw = stock_raw;
    member.guarantee = guarantee;
    member.top_ups = 0;
    member.forfeited = 0;
    member.rounds_paid = 0;
    member.allocated = 0;
    // O_i is zero until this member has received, so coverage saturates from
    // the start rather than reading as 0% (SPEC.md:70).
    member.last_coverage_bps = u32::MAX;

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
        stock_cover: valuation.h,
        guarantee,
        joined_bitmap: circle.joined_bitmap,
    });

    Ok(())
}
