//! `withdraw` (T12, SPEC §7).
//!
//! The one way money leaves a finished circle, for both endings. A Cancelled
//! circle returns exactly what each member put in; a Completed one shares out
//! what is left, pro rata by what each member deposited and did not forfeit.
//!
//! ## Why this reads snapshots and never decrements
//!
//! SPEC §7: "snapshot values, never decremented by withdraw". `withdraw` does
//! not touch `reserve_total`, `reserve_losses` or `escrow`, so every member's
//! share is computed against the same three numbers no matter who goes first.
//!
//! That is I16, and it is a property of the arithmetic rather than a promise
//! about behaviour. The tempting implementation, paying out of a pool that
//! shrinks as people withdraw, would make the last member's share depend on the
//! order, and the last member is the one least able to do anything about it.
//!
//! Rounding dust stays in the vault (KNOWN-LIMITS L6), which is the direction
//! that cannot overdraw.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::Withdrawn;
use crate::state::{Circle, CircleStatus, Member};

#[derive(Accounts)]
pub struct Withdraw<'info> {
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

    #[account(
        mut,
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

/// SPEC §7's share, in u128 and flooring.
///
/// Flooring is deliberate: the dust it leaves stays in the vault, and a circle
/// that pays out slightly less than it holds can always settle, while one that
/// rounds up cannot pay its last member.
fn completed_share(pool_left: u64, weight: u64, total_weight: u64) -> Result<u64> {
    if total_weight == 0 {
        // Every deposit was forfeited, so every weight is zero too. Nothing is
        // owed to anyone and the division has no meaning.
        return Ok(0);
    }

    let share = (pool_left as u128)
        .checked_mul(weight as u128)
        .ok_or(OthelloError::ValuationOverflow)?
        / total_weight as u128;

    u64::try_from(share).map_err(|_| OthelloError::ValuationOverflow.into())
}

pub fn handle_withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let circle = &ctx.accounts.circle;
    let member = &ctx.accounts.member;

    require!(
        matches!(
            circle.status,
            CircleStatus::Completed | CircleStatus::Cancelled
        ),
        OthelloError::NotFinished
    );
    require!(
        circle.withdrawn_bitmap & (1u8 << member.turn) == 0,
        OthelloError::AlreadyWithdrawn
    );

    let deposited = member
        .guarantee
        .checked_add(member.top_ups)
        .ok_or(OthelloError::ValuationOverflow)?;

    let usdc = match circle.status {
        // Nothing ever happened: the circle never activated, so no loss can
        // have been taken and everyone gets exactly what they put in.
        CircleStatus::Cancelled => deposited,
        _ => {
            // escrow is always 0 at Completed, because release_pot refuses
            // otherwise. It is in the sum because I3 counts it.
            let pool_left = circle
                .reserve_total
                .saturating_sub(circle.reserve_losses)
                .checked_add(circle.escrow)
                .ok_or(OthelloError::ValuationOverflow)?;

            let weight = deposited.saturating_sub(member.forfeited);
            let total_weight = circle.deposits_total.saturating_sub(circle.forfeited_total);

            completed_share(pool_left, weight, total_weight)?
        }
    };

    let stock = member.stock_raw;

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

    if usdc > 0 {
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
            usdc,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    let circle = &mut ctx.accounts.circle;
    let member = &mut ctx.accounts.member;
    let turn = member.turn;

    // reserve_total, reserve_losses and escrow are deliberately NOT touched.
    // They are the snapshot every other member's share is computed against, and
    // decrementing them here is exactly what would make the order matter (I16).
    circle.withdrawn_usdc = circle
        .withdrawn_usdc
        .checked_add(usdc)
        .ok_or(OthelloError::ValuationOverflow)?;
    circle.withdrawn_bitmap |= 1u8 << turn;

    // Zeroed so I4 stays true: the vault no longer holds this member's stock,
    // so the sum of member.stock_raw must no longer count it.
    member.stock_raw = 0;
    member.allocated = 0;

    emit!(Withdrawn {
        circle: circle.key(),
        member: member.key(),
        wallet: member.wallet,
        turn,
        usdc,
        stock,
        withdrawn_bitmap: circle.withdrawn_bitmap,
        withdrawn_usdc: circle.withdrawn_usdc,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    /// The demo circle finishing cleanly: no default, so nothing is forfeited
    /// and nothing is lost, and everyone gets exactly their guarantee back.
    #[test]
    fn a_clean_circle_returns_every_deposit_exactly() {
        let pool = 175 * USDC;
        let total = 175 * USDC;

        for _ in 0..5 {
            assert_eq!(completed_share(pool, 35 * USDC, total).unwrap(), 35 * USDC);
        }
    }

    /// The case the integration suite cannot reach in gate 2, because losses
    /// and forfeits need declare_default (T15) and top-ups need T16. The
    /// arithmetic is exercised here instead of being left until then.
    #[test]
    fn a_loss_is_shared_pro_rata_by_weight_and_never_overpays() {
        // 175 deposited, 40 lost to a default, so 135 is left to share. The
        // defaulter forfeited their whole 35, so four members share by weight.
        let pool = 135 * USDC;
        let total_weight = (175 - 35) * USDC;

        let each = completed_share(pool, 35 * USDC, total_weight).unwrap();
        assert_eq!(each, 33_750_000, "135 x 35 / 140");

        // The defaulter's own weight is zero, so they receive nothing.
        assert_eq!(completed_share(pool, 0, total_weight).unwrap(), 0);

        // And the four shares never exceed what the vault holds.
        assert!(each * 4 <= pool, "shares must not overdraw the pool");
    }

    #[test]
    fn dust_stays_in_the_vault_rather_than_overpaying_the_last_member() {
        // 100 across 3 equal weights is 33.33: each gets 33, one unit is dust.
        let each = completed_share(100, 10, 30).unwrap();

        assert_eq!(each, 33);
        assert!(
            each * 3 < 100,
            "the remainder stays behind, per KNOWN-LIMITS L6"
        );
    }

    #[test]
    fn a_circle_where_everything_was_forfeited_pays_nobody_rather_than_dividing_by_zero() {
        assert_eq!(completed_share(0, 0, 0).unwrap(), 0);
        assert_eq!(completed_share(10 * USDC, 0, 0).unwrap(), 0);
    }

    #[test]
    fn a_share_is_independent_of_the_order_it_is_computed_in() {
        // I16 at the arithmetic level: the inputs are snapshots, so computing
        // any member's share does not change any other member's inputs.
        let pool = 135 * USDC;
        let total = 140 * USDC;
        let weights = [35 * USDC, 35 * USDC, 35 * USDC, 35 * USDC, 0];

        let forward: Vec<u64> = weights
            .iter()
            .map(|&w| completed_share(pool, w, total).unwrap())
            .collect();
        let backward: Vec<u64> = weights
            .iter()
            .rev()
            .map(|&w| completed_share(pool, w, total).unwrap())
            .collect();

        assert_eq!(forward, backward.into_iter().rev().collect::<Vec<_>>());
    }
}
