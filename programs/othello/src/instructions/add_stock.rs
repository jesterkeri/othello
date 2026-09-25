//! `add_stock(raw)` (T16, SPEC §5).
//!
//! A member locks more of the same stock behind their seat, which raises their
//! cover and lowers what the reserve has to allocate to them. It changes no
//! reserve figure and does not refresh Paused (SPEC §5: "add_stock and price
//! changes do not refresh it"); the next update_coverage or release_pot sees it.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::StockAdded;
use crate::state::{Circle, CircleStatus, Member};

#[derive(Accounts)]
pub struct AddStock<'info> {
    pub wallet: Signer<'info>,

    #[account(
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = stock_mint,
    )]
    pub circle: Box<Account<'info, Circle>>,

    /// Existing only once the wallet has joined (join_and_lock creates it and
    /// leave_forming closes it), so this is also the "joined" check.
    #[account(
        mut,
        seeds = [Member::SEED, circle.key().as_ref(), wallet.key().as_ref()],
        bump = member.bump,
        has_one = circle,
        has_one = wallet,
    )]
    pub member: Box<Account<'info, Member>>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = wallet,
        associated_token::token_program = stock_token_program,
    )]
    pub member_stock_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = circle,
        associated_token::token_program = stock_token_program,
    )]
    pub circle_stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub stock_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_add_stock(ctx: Context<AddStock>, raw: u64) -> Result<()> {
    let circle = &ctx.accounts.circle;
    let turn = ctx.accounts.member.turn;

    require!(
        matches!(circle.status, CircleStatus::Forming | CircleStatus::Active),
        OthelloError::CircleNotActive
    );
    // A defaulter's stock was sold only up to what they owed, and the rest is
    // returned at withdraw. More stock behind a settled seat protects nobody.
    require!(
        circle.defaulted_bitmap & (1u8 << turn) == 0,
        OthelloError::AlreadyDefaulted
    );
    require!(raw > 0, OthelloError::InvalidParams);
    require!(
        ctx.accounts.member_stock_ata.amount >= raw,
        OthelloError::InsufficientBalance
    );

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
        raw,
        ctx.accounts.stock_mint.decimals,
    )?;

    let member = &mut ctx.accounts.member;
    member.stock_raw = member
        .stock_raw
        .checked_add(raw)
        .ok_or(OthelloError::ValuationOverflow)?;

    emit!(StockAdded {
        circle: ctx.accounts.circle.key(),
        wallet: ctx.accounts.wallet.key(),
        turn,
        raw,
        stock_raw: member.stock_raw,
    });

    Ok(())
}
