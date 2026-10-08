//! USDC as collateral (SPEC §4b; othello-design/USDC-COLLATERAL-DESIGN.md r8, Codex DESIGN-APPROVED).
//!
//! A seat may lock the circle's own USDC as well as, or instead of, stock; its cover is the sum. Locked USDC lives in
//! a per-seat `SeatCollateral` account and a per-circle collateral vault, so no existing account changes size and
//! nothing is migrated (Option B).
//!
//! Both are taken as raw, seed-checked accounts and read as a STATE UNION, never as a typed account before the union
//! is decided:
//! - absent: owned by the System Program with no data, whatever its lamports (anyone may send SOL to an address);
//! - present: exactly this program's SeatCollateral for this circle and wallet, or exactly an SPL Token account of
//!   APPROVED_USDC whose authority is the circle PDA.
//!
//! Anything else is refused. A seat's absent SeatCollateral means `usdc_locked = 0`.
//!
//! This file holds the union readers and creators every USDC path shares, and the two instructions that only exist
//! for USDC: `enable_usdc_collateral` (the one-way switch) and `add_usdc_collateral`.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{
    allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
};
use anchor_spl::token::{initialize_account3, InitializeAccount3};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::allowlist::APPROVED_USDC;
use crate::errors::OthelloError;
use crate::events::{UsdcCollateralAdded, UsdcCollateralEnabled};
use crate::state::{Circle, CircleStatus, Features, Member, SeatCollateral, COLLATERAL_VAULT_SEED};

/// An SPL Token account's size. The collateral vault is a classic SPL Token account of APPROVED_USDC, which has no
/// extensions, so this is exact.
const TOKEN_ACCOUNT_LEN: usize = <anchor_spl::token::spl_token::state::Account as anchor_lang::solana_program::program_pack::Pack>::LEN;

/// "Absent", exactly: owned by the System Program with no data, whatever its lamports.
pub fn is_absent(account: &AccountInfo) -> bool {
    *account.owner == anchor_lang::system_program::ID && account.data_is_empty()
}

pub fn seat_collateral_address(circle: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SeatCollateral::SEED, circle.as_ref(), wallet.as_ref()],
        &crate::ID,
    )
}

pub fn collateral_vault_address(circle: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[COLLATERAL_VAULT_SEED, circle.as_ref()], &crate::ID)
}

/// A seat's SeatCollateral, read once: what it holds and the bump of its address.
pub struct SeatRead {
    pub usdc_locked: u64,
    pub bump: u8,
}

/// Reads a seat's SeatCollateral address as a state union: 0 when absent; the account's own figure when it is this
/// program's SeatCollateral for exactly this circle and wallet; refused otherwise.
///
/// Compute (NFR-3, U1 adversary): an absent account's address is found once with find_program_address (1,500 CU
/// per bump tried); a present one is checked with create_program_address at its stored bump, a single try. Callers
/// read once and pass the result on, never re-deriving.
pub fn read_seat_collateral(
    account: &AccountInfo,
    circle: &Pubkey,
    wallet: &Pubkey,
) -> Result<SeatRead> {
    if is_absent(account) {
        let (address, bump) = seat_collateral_address(circle, wallet);
        require_keys_eq!(account.key(), address, OthelloError::BadSeatCollateral);
        return Ok(SeatRead {
            usdc_locked: 0,
            bump,
        });
    }
    require_keys_eq!(*account.owner, crate::ID, OthelloError::BadSeatCollateral);
    let data = account.try_borrow_data()?;
    let seat = SeatCollateral::try_deserialize(&mut &data[..])
        .map_err(|_| error!(OthelloError::BadSeatCollateral))?;
    require!(
        seat.circle == *circle && seat.wallet == *wallet,
        OthelloError::BadSeatCollateral
    );
    let address = Pubkey::create_program_address(
        &[
            SeatCollateral::SEED,
            circle.as_ref(),
            wallet.as_ref(),
            &[seat.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(OthelloError::BadSeatCollateral))?;
    require_keys_eq!(account.key(), address, OthelloError::BadSeatCollateral);
    Ok(SeatRead {
        usdc_locked: seat.usdc_locked,
        bump: seat.bump,
    })
}

/// The collateral vault as a state union.
pub enum CollateralVault {
    Absent,
    Present { amount: u64 },
}

/// The collateral vault, read once: its state and the bump of its address (found once; a token account stores none).
pub struct VaultRead {
    pub state: CollateralVault,
    pub bump: u8,
}

/// Reads the collateral vault: its key must be the circle's PDA exactly (a circle USDC vault or any other token
/// account of the right mint and authority is refused); absent, or an SPL Token account of APPROVED_USDC whose
/// authority is the circle.
pub fn read_collateral_vault(account: &AccountInfo, circle: &Pubkey) -> Result<VaultRead> {
    let (address, bump) = collateral_vault_address(circle);
    require_keys_eq!(account.key(), address, OthelloError::BadCollateralVault);
    if is_absent(account) {
        return Ok(VaultRead {
            state: CollateralVault::Absent,
            bump,
        });
    }
    require_keys_eq!(
        *account.owner,
        anchor_spl::token::ID,
        OthelloError::BadCollateralVault
    );
    let data = account.try_borrow_data()?;
    let vault = anchor_spl::token::TokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| error!(OthelloError::BadCollateralVault))?;
    require!(
        vault.mint == APPROVED_USDC && vault.owner == *circle,
        OthelloError::BadCollateralVault
    );
    Ok(VaultRead {
        state: CollateralVault::Present {
            amount: vault.amount,
        },
        bump,
    })
}

/// Requires the feature marker: this program's Features account at exactly the `["features"]` PDA, checked at its
/// stored bump (one create_program_address, not a search).
pub fn require_usdc_enabled(features: &AccountInfo) -> Result<()> {
    require!(
        *features.owner == crate::ID && !features.data_is_empty(),
        OthelloError::UsdcCollateralNotEnabled
    );
    let data = features.try_borrow_data()?;
    let marker = Features::try_deserialize(&mut &data[..])
        .map_err(|_| error!(OthelloError::UsdcCollateralNotEnabled))?;
    let address = Pubkey::create_program_address(&[Features::SEED, &[marker.bump]], &crate::ID)
        .map_err(|_| error!(OthelloError::UsdcCollateralNotEnabled))?;
    require_keys_eq!(
        features.key(),
        address,
        OthelloError::UsdcCollateralNotEnabled
    );
    Ok(())
}

/// The circle may take USDC collateral only on the approved mint under SPL Token ([F1]).
pub fn require_approved_usdc(circle: &Circle, usdc_token_program: &Pubkey) -> Result<()> {
    require_keys_eq!(
        circle.usdc_mint,
        APPROVED_USDC,
        OthelloError::UsdcMintNotApproved
    );
    require_keys_eq!(
        *usdc_token_program,
        anchor_spl::token::ID,
        OthelloError::UsdcMintNotApproved
    );
    Ok(())
}

/// Creates a PDA account owned by `owner`, also when someone has already sent lamports to its address (a plain
/// create_account would then fail): the rent is topped up, then the space allocated and the owner assigned.
fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    let signer: &[&[&[u8]]] = &[seeds];
    if target.lamports() == 0 {
        return create_account(
            CpiContext::new_with_signer(
                system_program.key(),
                CreateAccount {
                    from: payer.clone(),
                    to: target.clone(),
                },
                signer,
            ),
            rent,
            space as u64,
            owner,
        );
    }
    let short = rent.saturating_sub(target.lamports());
    if short > 0 {
        transfer(
            CpiContext::new(
                system_program.key(),
                Transfer {
                    from: payer.clone(),
                    to: target.clone(),
                },
            ),
            short,
        )?;
    }
    allocate(
        CpiContext::new_with_signer(
            system_program.key(),
            Allocate {
                account_to_allocate: target.clone(),
            },
            signer,
        ),
        space as u64,
    )?;
    assign(
        CpiContext::new_with_signer(
            system_program.key(),
            Assign {
                account_to_assign: target.clone(),
            },
            signer,
        ),
        owner,
    )
}

/// The accounts every USDC lock moves through.
pub struct UsdcLock<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub circle: &'a AccountInfo<'info>,
    pub wallet: Pubkey,
    pub seat_collateral: &'a AccountInfo<'info>,
    pub collateral_vault: &'a AccountInfo<'info>,
    pub usdc_mint: &'a InterfaceAccount<'info, Mint>,
    pub member_usdc_ata: &'a InterfaceAccount<'info, TokenAccount>,
    pub usdc_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Moves `amount` of the member's USDC into the collateral vault (created if absent) and adds it to the seat's
/// SeatCollateral (created if absent). Returns the seat's new `usdc_locked`. `seat` and `vault` are the caller's own
/// reads of those two accounts (read_seat_collateral, read_collateral_vault), made before anything moved, so a bad
/// account refused with nothing done; they are not re-derived here. The caller has checked the marker, the approved
/// mint and the member's balance.
pub fn lock_usdc(l: &UsdcLock, amount: u64, seat: &SeatRead, vault: &VaultRead) -> Result<u64> {
    let circle = l.circle.key();

    if let CollateralVault::Absent = vault.state {
        let bump = vault.bump;
        create_pda(
            l.payer,
            l.collateral_vault,
            l.system_program,
            TOKEN_ACCOUNT_LEN,
            &anchor_spl::token::ID,
            &[COLLATERAL_VAULT_SEED, circle.as_ref(), &[bump]],
        )?;
        initialize_account3(CpiContext::new(
            l.usdc_token_program.key(),
            InitializeAccount3 {
                account: l.collateral_vault.clone(),
                mint: l.usdc_mint.to_account_info(),
                authority: l.circle.clone(),
            },
        ))?;
    }

    // The member's own signature: a member's USDC only leaves on their authority.
    transfer_checked(
        CpiContext::new(
            l.usdc_token_program.key(),
            TransferChecked {
                from: l.member_usdc_ata.to_account_info(),
                mint: l.usdc_mint.to_account_info(),
                to: l.collateral_vault.clone(),
                authority: l.payer.clone(),
            },
        ),
        amount,
        l.usdc_mint.decimals,
    )?;

    let bump = seat.bump;
    if is_absent(l.seat_collateral) {
        create_pda(
            l.payer,
            l.seat_collateral,
            l.system_program,
            8 + SeatCollateral::INIT_SPACE,
            &crate::ID,
            &[
                SeatCollateral::SEED,
                circle.as_ref(),
                l.wallet.as_ref(),
                &[bump],
            ],
        )?;
    }
    let usdc_locked = seat
        .usdc_locked
        .checked_add(amount)
        .ok_or(OthelloError::ValuationOverflow)?;
    let written = SeatCollateral {
        circle,
        wallet: l.wallet,
        usdc_locked,
        bump,
    };
    let mut data = l.seat_collateral.try_borrow_mut_data()?;
    written.try_serialize(&mut &mut data[..])?;

    Ok(usdc_locked)
}

#[derive(Accounts)]
pub struct EnableUsdcCollateral<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// The admin is the program's upgrade authority, read from the loader's own ProgramData (as init_price_feed).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ OthelloError::Unauthorized)]
    pub program: Program<'info, crate::program::Othello>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ OthelloError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    /// One-way: `init` refuses a second call, and nothing closes it.
    #[account(
        init,
        payer = authority,
        space = 8 + Features::INIT_SPACE,
        seeds = [Features::SEED],
        bump
    )]
    pub features: Account<'info, Features>,
    pub system_program: Program<'info, System>,
}

/// SPEC §4b: lets USDC be locked from now on. Moves no tokens and has authority over no other account (I8).
pub fn handle_enable_usdc_collateral(ctx: Context<EnableUsdcCollateral>) -> Result<()> {
    ctx.accounts.features.bump = ctx.bumps.features;
    emit!(UsdcCollateralEnabled {
        features: ctx.accounts.features.key(),
        enabled_by: ctx.accounts.authority.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AddUsdcCollateral<'info> {
    /// Pays for the SeatCollateral and the collateral vault if either is absent.
    #[account(mut)]
    pub wallet: Signer<'info>,

    #[account(
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = usdc_mint,
    )]
    pub circle: Box<Account<'info, Circle>>,

    /// Existing only once the wallet has joined, so this is also the "joined" check (as add_stock).
    #[account(
        seeds = [Member::SEED, circle.key().as_ref(), wallet.key().as_ref()],
        bump = member.bump,
        has_one = circle,
        has_one = wallet,
    )]
    pub member: Box<Account<'info, Member>>,

    /// CHECK: the seat's SeatCollateral as a state union (absent or exactly this seat's), read by
    /// `seat_usdc_locked` and created by `lock_usdc`.
    #[account(mut)]
    pub seat_collateral: UncheckedAccount<'info>,

    /// CHECK: the circle's collateral vault as a state union, read by `read_collateral_vault` and created by
    /// `lock_usdc`.
    #[account(mut)]
    pub collateral_vault: UncheckedAccount<'info>,

    /// CHECK: the feature marker, checked by `require_usdc_enabled`.
    pub features: UncheckedAccount<'info>,

    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = wallet,
        associated_token::token_program = usdc_token_program,
    )]
    pub member_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_add_usdc_collateral(ctx: Context<AddUsdcCollateral>, amount: u64) -> Result<()> {
    let circle = &ctx.accounts.circle;
    let turn = ctx.accounts.member.turn;

    require!(
        matches!(circle.status, CircleStatus::Forming | CircleStatus::Active),
        OthelloError::CircleNotActive
    );
    // As add_stock: more collateral behind a settled seat protects nobody.
    require!(
        circle.defaulted_bitmap & (1u8 << turn) == 0,
        OthelloError::AlreadyDefaulted
    );
    require!(amount > 0, OthelloError::InvalidParams);
    require_usdc_enabled(&ctx.accounts.features)?;
    require_approved_usdc(circle, &ctx.accounts.usdc_token_program.key())?;
    require!(
        ctx.accounts.member_usdc_ata.amount >= amount,
        OthelloError::InsufficientBalance
    );

    let seat = read_seat_collateral(
        &ctx.accounts.seat_collateral,
        &ctx.accounts.circle.key(),
        &ctx.accounts.wallet.key(),
    )?;
    let vault = read_collateral_vault(&ctx.accounts.collateral_vault, &ctx.accounts.circle.key())?;
    let usdc_locked = lock_usdc(
        &UsdcLock {
            payer: &ctx.accounts.wallet.to_account_info(),
            circle: &ctx.accounts.circle.to_account_info(),
            wallet: ctx.accounts.wallet.key(),
            seat_collateral: &ctx.accounts.seat_collateral.to_account_info(),
            collateral_vault: &ctx.accounts.collateral_vault.to_account_info(),
            usdc_mint: &ctx.accounts.usdc_mint,
            member_usdc_ata: &ctx.accounts.member_usdc_ata,
            usdc_token_program: &ctx.accounts.usdc_token_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        amount,
        &seat,
        &vault,
    )?;

    emit!(UsdcCollateralAdded {
        circle: ctx.accounts.circle.key(),
        wallet: ctx.accounts.wallet.key(),
        turn,
        amount,
        usdc_locked,
    });

    Ok(())
}
