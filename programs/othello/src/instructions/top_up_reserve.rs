//! `top_up_reserve(amount)` (T16, SPEC §5).
//!
//! The cure for Paused. Any member who has not defaulted can add USDC to the
//! circle, and it goes where the circle is shortest first: an escrow deficit
//! (defaulted contributions the reserve could not prepay) is filled before
//! anything reaches the reserve. That order is I14's: a deficit is only curable
//! if a top-up reaches it.
//!
//! `next_gate_short_by` is updated in closed form rather than by revaluing
//! everyone (SPEC r4): with prices unchanged it is exact, so a top-up of
//! exactly `short_by` unpauses the circle without needing a fresh price (I18).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::ReserveToppedUp;
use crate::state::{Circle, CircleStatus, Member};

#[derive(Accounts)]
pub struct TopUpReserve<'info> {
    pub wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = usdc_mint,
    )]
    pub circle: Box<Account<'info, Circle>>,

    /// Seeds bind this to (circle, wallet): a top-up is always credited to the
    /// signer's own seat, which is what withdraw pays it back against.
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

/// SPEC §5's arithmetic, apart from the transfer, so it can be unit-tested.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TopUp {
    /// `min(escrow_deficit, amount)`: the part that prepays defaulted seats.
    pub fill: u64,
    pub escrow: u64,
    pub escrow_deficit: u64,
    pub reserve_total: u64,
    pub next_gate_short_by: u64,
}

pub fn top_up(
    amount: u64,
    escrow: u64,
    escrow_deficit: u64,
    reserve_total: u64,
    next_gate_short_by: u64,
) -> Result<TopUp> {
    let fill = escrow_deficit.min(amount);
    let to_reserve = amount - fill;

    // next_gate_short_by = max(0, (v - D) - (amount - fill)) + (D - fill).
    // v already includes D (every writer adds the deficit on top), so v - D is
    // the reserve's own shortfall; saturating keeps a stale v below D from
    // underflowing, and then the reserve part simply reads 0.
    let reserve_short = next_gate_short_by
        .saturating_sub(escrow_deficit)
        .saturating_sub(to_reserve);
    let deficit_left = escrow_deficit - fill;

    Ok(TopUp {
        fill,
        escrow: escrow
            .checked_add(fill)
            .ok_or(OthelloError::ValuationOverflow)?,
        escrow_deficit: deficit_left,
        reserve_total: reserve_total
            .checked_add(to_reserve)
            .ok_or(OthelloError::ValuationOverflow)?,
        next_gate_short_by: reserve_short
            .checked_add(deficit_left)
            .ok_or(OthelloError::ValuationOverflow)?,
    })
}

pub fn handle_top_up_reserve(ctx: Context<TopUpReserve>, amount: u64) -> Result<()> {
    let circle = &ctx.accounts.circle;
    let turn = ctx.accounts.member.turn;

    require!(
        circle.status == CircleStatus::Active,
        OthelloError::CircleNotActive
    );
    // A defaulter's collateral already settled their share; letting them add
    // to the reserve would give them a withdraw weight bought after the fact.
    require!(
        circle.defaulted_bitmap & (1u8 << turn) == 0,
        OthelloError::AlreadyDefaulted
    );
    // A zero top-up changes nothing but would still emit an event claiming a
    // top-up happened, which an indexer would count.
    require!(amount > 0, OthelloError::InvalidParams);
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

    let t = top_up(
        amount,
        circle.escrow,
        circle.escrow_deficit,
        circle.reserve_total,
        circle.next_gate_short_by,
    )?;

    let member = &mut ctx.accounts.member;
    member.top_ups = member
        .top_ups
        .checked_add(amount)
        .ok_or(OthelloError::ValuationOverflow)?;

    let circle = &mut ctx.accounts.circle;
    circle.escrow = t.escrow;
    circle.escrow_deficit = t.escrow_deficit;
    circle.reserve_total = t.reserve_total;
    circle.next_gate_short_by = t.next_gate_short_by;
    // reserve_losses does not move (r3): a fill is money that prepaid a
    // default, shown in the UI as deposits_total - reserve_total.
    circle.deposits_total = circle
        .deposits_total
        .checked_add(amount)
        .ok_or(OthelloError::ValuationOverflow)?;

    emit!(ReserveToppedUp {
        circle: circle.key(),
        wallet: ctx.accounts.wallet.key(),
        turn,
        amount,
        fill: t.fill,
        escrow: circle.escrow,
        escrow_deficit: circle.escrow_deficit,
        reserve_total: circle.reserve_total,
        deposits_total: circle.deposits_total,
        next_gate_short_by: circle.next_gate_short_by,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    #[test]
    fn the_halt_example_a_top_up_of_exactly_short_by_unpauses() {
        // Design review r4, SPEC §7 halt example: needed 75, remaining 70,
        // short_by 5, no deficit. A top-up of 5 all reaches the reserve.
        let t = top_up(5 * USDC, 200 * USDC, 0, 150 * USDC, 5 * USDC).unwrap();
        assert_eq!(t.fill, 0);
        assert_eq!(t.reserve_total, 155 * USDC);
        assert_eq!(t.next_gate_short_by, 0);
    }

    #[test]
    fn a_deficit_is_filled_before_anything_reaches_the_reserve() {
        // Deficit 6, reserve short 4 on top of it (v = 10). A top-up of 8
        // fills all 6, and only 2 reaches the reserve: still short 2.
        let t = top_up(8 * USDC, 44 * USDC, 6 * USDC, 150 * USDC, 10 * USDC).unwrap();
        assert_eq!(t.fill, 6 * USDC);
        assert_eq!(t.escrow, 50 * USDC);
        assert_eq!(t.escrow_deficit, 0);
        assert_eq!(t.reserve_total, 152 * USDC);
        assert_eq!(t.next_gate_short_by, 2 * USDC);
    }

    #[test]
    fn a_top_up_smaller_than_the_deficit_leaves_the_rest_owed() {
        let t = top_up(4 * USDC, 44 * USDC, 6 * USDC, 150 * USDC, 6 * USDC).unwrap();
        assert_eq!(t.fill, 4 * USDC);
        assert_eq!(t.escrow_deficit, 2 * USDC);
        assert_eq!(
            t.reserve_total,
            150 * USDC,
            "none of it reached the reserve"
        );
        assert_eq!(t.next_gate_short_by, 2 * USDC);
    }

    #[test]
    fn topping_up_a_healthy_circle_leaves_it_healthy() {
        let t = top_up(10 * USDC, 0, 0, 175 * USDC, 0).unwrap();
        assert_eq!(t.reserve_total, 185 * USDC);
        assert_eq!(t.next_gate_short_by, 0);
    }
}
