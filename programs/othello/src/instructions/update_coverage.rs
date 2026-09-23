//! `update_coverage` (T11, SPEC §5).
//!
//! Anyone can recompute the circle's coverage. It moves no money and takes
//! nothing from the caller, which is what makes "anyone" safe: the worst a
//! caller can do is tell the truth at a moment of their choosing.
//!
//! The difference from `release_pot`'s gate is the allocation. The gate
//! compares the UNCAPPED sum and refuses if it does not fit. This one always
//! succeeds and distributes what there is, in turn order, capping each member
//! at what is left. SPEC.md:126 names that distinction: the gate's `remaining`
//! is R - L, while `reserve_allocated` everywhere else is the capped,
//! turn-order-distributed figure.
//!
//! So a Paused circle is not one this instruction refuses. It is one where
//! `next_gate_short_by` comes back greater than zero.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::errors::OthelloError;
use crate::events::CoverageUpdated;
use crate::gate::{
    allocate_in_turn_order, coverage_bps, need, obligations, obligations_next_round,
};
use crate::state::{Circle, CircleStatus, Member, PriceFeed};
use crate::valuation::value_position;

#[derive(Accounts)]
pub struct UpdateCoverage<'info> {
    /// Anyone, including a keeper script. Nothing is paid and nothing is moved.
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = stock_mint,
        has_one = price_feed,
    )]
    pub circle: Box<Account<'info, Circle>>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [PriceFeed::SEED, stock_mint.key().as_ref()],
        bump = price_feed.bump,
        has_one = stock_mint,
    )]
    pub price_feed: Box<Account<'info, PriceFeed>>,
}

pub fn handle_update_coverage<'info>(ctx: Context<'info, UpdateCoverage<'info>>) -> Result<()> {
    let circle = &ctx.accounts.circle;

    // SPEC §5: refused at Completed. A finished circle owes nothing, and
    // `release_pot` already set next_gate_short_by to 0 on the last payout;
    // recomputing would be describing a gate that will never run.
    require!(
        circle.status == CircleStatus::Active,
        OthelloError::CircleNotActive
    );

    let n = circle.n;
    require!(
        ctx.remaining_accounts.len() == n as usize,
        OthelloError::BadMemberAccounts
    );

    let now = Clock::get()?.unix_timestamp;

    let mut members: Vec<Account<'info, Member>> = Vec::with_capacity(n as usize);
    let mut covers: Vec<u64> = Vec::with_capacity(n as usize);
    let mut obligs: Vec<u64> = Vec::with_capacity(n as usize);
    let mut needs: Vec<u64> = Vec::with_capacity(n as usize);

    {
        let mint_info = ctx.accounts.stock_mint.to_account_info();
        let mint_data = mint_info.try_borrow_data()?;

        for (index, info) in ctx.remaining_accounts.iter().enumerate() {
            let member: Account<'info, Member> = Account::try_from(info)?;

            // Each validated against its seat, per SPEC §5. Index IS turn, so
            // the caller cannot reorder the list to change who is allocated
            // first: turn order is the allocation rule.
            require!(
                member.circle == circle.key() && member.turn as usize == index,
                OthelloError::BadMemberAccounts
            );
            require!(info.is_writable, OthelloError::BadMemberAccounts);

            let bit = 1u8 << member.turn;
            let defaulted = circle.defaulted_bitmap & bit != 0;
            let received = circle.received_bitmap & bit != 0;

            // A defaulted member's obligations were prepaid by the waterfall
            // and their allocation released, so they take nothing from the
            // reserve and their coverage reads as Prepaid, not as a number.
            let cover = if defaulted {
                0
            } else {
                value_position(
                    &ctx.accounts.price_feed,
                    &mint_data,
                    member.stock_raw,
                    circle.haircut_bps,
                    now,
                    circle.max_price_age,
                )?
                .h
            };
            let o = if defaulted {
                0
            } else {
                obligations(circle.contribution, n, member.rounds_paid, received)?
            };

            covers.push(cover);
            obligs.push(o);
            needs.push(need(o, cover, circle.coverage_bps)?);
            members.push(member);
        }
    }

    // R - L. Not the free figure: nothing is allocated yet at this point, and
    // this instruction is what decides what free becomes.
    let remaining = circle.reserve_total.saturating_sub(circle.reserve_losses);
    let allocated = allocate_in_turn_order(&needs, remaining);

    let mut total: u64 = 0;
    for (index, member) in members.iter_mut().enumerate() {
        let take = allocated[index];
        member.allocated = take;
        member.last_coverage_bps = coverage_bps(covers[index], take, obligs[index]);
        total = total
            .checked_add(take)
            .ok_or(OthelloError::ValuationOverflow)?;
        member.exit(&crate::ID)?;
    }

    // `next_gate_short_by` describes the gate that has NOT run yet, so SPEC §5
    // (r4) is explicit that it projects obligations forward with
    // c x (n - round - 1) and never reads the stored rounds_paid. Using
    // rounds_paid here would describe the gate that already passed.
    let projected = obligations_next_round(circle.contribution, n, circle.round)?;
    let mut next_needed: u64 = 0;
    for (index, member) in members.iter().enumerate() {
        let bit = 1u8 << member.turn;
        if circle.defaulted_bitmap & bit != 0 {
            continue;
        }
        // Every received member, and the member about to receive: those are the
        // seats the next gate will have to stand behind.
        let counted = circle.received_bitmap & bit != 0 || member.turn == circle.round;
        if !counted {
            continue;
        }
        next_needed = next_needed
            .checked_add(need(projected, covers[index], circle.coverage_bps)?)
            .ok_or(OthelloError::ValuationOverflow)?;
    }

    let circle = &mut ctx.accounts.circle;
    circle.reserve_allocated = total;
    circle.next_gate_short_by = next_needed
        .saturating_sub(remaining)
        .saturating_add(circle.escrow_deficit);
    circle.last_coverage_at = now;

    emit!(CoverageUpdated {
        circle: circle.key(),
        round: circle.round,
        reserve_allocated: circle.reserve_allocated,
        remaining,
        next_gate_short_by: circle.next_gate_short_by,
        last_coverage_at: now,
    });

    Ok(())
}
