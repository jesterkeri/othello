//! `contribute` (T10, SPEC §5).
//!
//! Deliberately has NO time check. SPEC §5 marks that (r2): a payment that
//! arrives after the deadline, but before anyone has declared a default, is a
//! cure and must be accepted. Refusing it would turn a late payer into a
//! defaulter on a clock the program cannot see them racing.
//!
//! That is also why `contribute` is not the place the round advances. It only
//! ever adds; `release_pot` is what closes a round.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::Contributed;
use crate::state::{Circle, CircleStatus, Member};

#[derive(Accounts)]
pub struct Contribute<'info> {
    pub wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = usdc_mint,
    )]
    pub circle: Box<Account<'info, Circle>>,

    /// The seeds bind this to (circle, wallet), so the signer can only ever
    /// contribute for their own seat.
    #[account(
        mut,
        seeds = [Member::SEED, circle.key().as_ref(), wallet.key().as_ref()],
        bump = member.bump,
        has_one = circle,
        has_one = wallet,
    )]
    pub member: Box<Account<'info, Member>>,

    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = wallet,
        associated_token::token_program = usdc_token_program,
    )]
    pub member_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = circle,
        associated_token::token_program = usdc_token_program,
    )]
    pub circle_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub usdc_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_contribute(ctx: Context<Contribute>) -> Result<()> {
    let circle = &ctx.accounts.circle;
    let turn = ctx.accounts.member.turn;

    require!(
        circle.status == CircleStatus::Active,
        OthelloError::CircleNotActive
    );
    require!(
        circle.defaulted_bitmap & (1u8 << turn) == 0,
        OthelloError::AlreadyDefaulted
    );
    require!(
        circle.paid_bitmap & (1u8 << turn) == 0,
        OthelloError::AlreadyContributed
    );

    let amount = circle.contribution;
    require!(
        ctx.accounts.member_usdc_ata.amount >= amount,
        OthelloError::InsufficientBalance
    );

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
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let circle = &mut ctx.accounts.circle;
    circle.paid_bitmap |= 1u8 << turn;
    circle.held_contributions = circle
        .held_contributions
        .checked_add(amount)
        .ok_or(OthelloError::ValuationOverflow)?;

    let member = &mut ctx.accounts.member;
    member.rounds_paid = member
        .rounds_paid
        .checked_add(1)
        .ok_or(OthelloError::ValuationOverflow)?;

    emit!(Contributed {
        circle: circle.key(),
        member: member.key(),
        turn,
        round: circle.round,
        amount,
        paid_bitmap: circle.paid_bitmap,
        held_contributions: circle.held_contributions,
    });

    Ok(())
}
