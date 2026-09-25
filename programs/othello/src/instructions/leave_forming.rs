//! `leave_forming` (G2 repair, 2026-09-24).
//!
//! Codex's gate 2 review found that a member who joins a Forming circle could
//! not recover their stock or guarantee if the creator did nothing. Only the
//! creator could cancel, and `withdraw` refuses unless Completed or Cancelled,
//! so an ordinary stalled formation, with no bad actor anywhere, left a live
//! circle holding other people's money with no exit.
//!
//! The design's answer, and the shape of this instruction: any JOINED member
//! may leave at any time before activation. No formation deadline, and no
//! override for anyone else. The asymmetry that caused the problem was that
//! joining was the member's decision and leaving was not; this removes it.
//!
//! It is deliberately not a partial unwind. Everything that came in goes back
//! and the Member account is closed, so the seat is exactly as it was before
//! the join and the same wallet can rejoin cleanly. A half-left member would be
//! a state nothing else in the protocol knows how to read.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::MemberLeftForming;
use crate::state::{Circle, CircleStatus, Member};

#[derive(Accounts)]
pub struct LeaveForming<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = stock_mint,
        has_one = usdc_mint,
    )]
    pub circle: Box<Account<'info, Circle>>,

    /// Closed to the wallet that opened it, so the rent goes back to whoever
    /// paid it and `join_and_lock`'s `init` can create it again on a rejoin.
    #[account(
        mut,
        close = wallet,
        seeds = [Member::SEED, circle.key().as_ref(), wallet.key().as_ref()],
        bump = member.bump,
        has_one = circle,
        has_one = wallet,
    )]
    pub member: Box<Account<'info, Member>>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

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
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = circle,
        associated_token::token_program = stock_token_program,
    )]
    pub circle_stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = circle,
        associated_token::token_program = usdc_token_program,
    )]
    pub circle_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub stock_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_leave_forming(ctx: Context<LeaveForming>) -> Result<()> {
    let circle = &ctx.accounts.circle;
    let member = &ctx.accounts.member;

    // Before activation only. Once Active the pot ordering depends on every
    // seat being filled, and a member's collateral is standing behind
    // obligations that exist; after that, leaving is `withdraw` at the end.
    require!(
        circle.status == CircleStatus::Forming,
        OthelloError::CircleNotForming
    );

    let turn = member.turn;
    let stock = member.stock_raw;

    // `top_ups` cannot be non-zero in Forming, because top_up_reserve is Active
    // only. It is included anyway so that the unwind is the exact inverse of
    // everything that has entered on this member's behalf: if that ever changes
    // this returns the money rather than stranding it.
    let deposited = member
        .guarantee
        .checked_add(member.top_ups)
        .ok_or(OthelloError::ValuationOverflow)?;

    let creator = circle.creator;
    let circle_id = circle.circle_id.to_le_bytes();
    let bump = circle.bump;
    let seeds: &[&[u8]] = &[Circle::SEED, creator.as_ref(), &circle_id, &[bump]];

    if stock > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.stock_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.circle_stock_vault.to_account_info(),
                    mint: ctx.accounts.stock_mint.to_account_info(),
                    to: ctx.accounts.member_stock_ata.to_account_info(),
                    authority: ctx.accounts.circle.to_account_info(),
                },
                &[seeds],
            ),
            stock,
            ctx.accounts.stock_mint.decimals,
        )?;
    }

    if deposited > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.usdc_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.circle_usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.member_usdc_ata.to_account_info(),
                    authority: ctx.accounts.circle.to_account_info(),
                },
                &[seeds],
            ),
            deposited,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    let circle = &mut ctx.accounts.circle;

    circle.joined_bitmap &= !(1u8 << turn);

    // Both come down. reserve_total because the money has left the vault, which
    // is I3; deposits_total because it is the denominator of withdraw's pro
    // rata and must only count deposits that are still settled here. That is
    // the rewording the design pack owes: "ever deposited" was true only while
    // nothing could be unwound.
    circle.reserve_total = circle
        .reserve_total
        .checked_sub(deposited)
        .ok_or(OthelloError::ValuationOverflow)?;
    circle.deposits_total = circle
        .deposits_total
        .checked_sub(deposited)
        .ok_or(OthelloError::ValuationOverflow)?;

    // withdrawn_usdc and withdrawn_bitmap are deliberately untouched. They
    // describe the settlement of a FINISHED circle, and nothing has finished
    // here: counting an unwind as a withdrawal would make I11 read a refund as
    // a payout and would mark a seat withdrawn that may yet rejoin.

    emit!(MemberLeftForming {
        circle: circle.key(),
        wallet: ctx.accounts.wallet.key(),
        turn,
        stock,
        usdc: deposited,
        joined_bitmap: circle.joined_bitmap,
        reserve_total: circle.reserve_total,
        deposits_total: circle.deposits_total,
    });

    Ok(())
}
