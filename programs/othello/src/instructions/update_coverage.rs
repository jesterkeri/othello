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
    allocate_in_turn_order, checked_total, coverage_bps, need, obligations, obligations_next_round,
    short_by,
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
    // SPEC §5: refused at Completed. A finished circle owes nothing, and
    // `release_pot` already set next_gate_short_by to 0 on the last payout;
    // recomputing would be describing a gate that will never run.
    require!(
        ctx.accounts.circle.status == CircleStatus::Active,
        OthelloError::CircleNotActive
    );

    let circle_key = ctx.accounts.circle.key();
    let mut members = load_members(&ctx.accounts.circle, circle_key, ctx.remaining_accounts)?;
    let now = Clock::get()?.unix_timestamp;

    let remaining = {
        let mint_info = ctx.accounts.stock_mint.to_account_info();
        let mint_data = mint_info.try_borrow_data()?;
        recompute_coverage(
            &mut ctx.accounts.circle,
            &mut members,
            &ctx.accounts.price_feed,
            &mint_data,
            now,
        )?
    };

    for member in members.iter() {
        member.exit(&crate::ID)?;
    }

    let circle = &ctx.accounts.circle;
    emit!(CoverageUpdated {
        circle: circle_key,
        round: circle.round,
        reserve_allocated: circle.reserve_allocated,
        remaining,
        next_gate_short_by: circle.next_gate_short_by,
        last_coverage_at: now,
    });

    Ok(())
}

/// Every Member account of a circle, from `remaining_accounts`, each validated
/// against its seat (SPEC §5): it belongs to this circle, its turn is its
/// index, and it is writable. Index IS turn, so a caller cannot reorder the
/// list to change who is allocated first: turn order is the allocation rule.
///
/// Shared by `update_coverage` and `declare_default`, which both write every
/// member's allocation.
pub(crate) fn load_members<'info>(
    circle: &Circle,
    circle_key: Pubkey,
    accounts: &'info [AccountInfo<'info>],
) -> Result<Vec<Account<'info, Member>>> {
    require!(
        accounts.len() == circle.n as usize,
        OthelloError::BadMemberAccounts
    );

    let mut members = Vec::with_capacity(accounts.len());
    for (index, info) in accounts.iter().enumerate() {
        // Anything that is not a Member account at all (system-owned, another
        // program's, the wrong discriminator) is the same refusal as a Member
        // in the wrong seat: SPEC §5 names bad_member_accounts for both, and a
        // client can only follow a documented recovery path (Gate 3 r1).
        let member: Account<'info, Member> =
            Account::try_from(info).map_err(|_| error!(OthelloError::BadMemberAccounts))?;
        require!(
            member.circle == circle_key && member.turn as usize == index,
            OthelloError::BadMemberAccounts
        );
        require!(info.is_writable, OthelloError::BadMemberAccounts);
        members.push(member);
    }

    Ok(members)
}

/// The coverage recompute, SPEC §5's `update_coverage` effect, and what
/// `declare_default` runs "exactly as update_coverage" when the price is fresh
/// and not repricing. One copy, so the two can never drift apart.
///
/// Writes every member's `allocated` and `last_coverage_bps`, and the circle's
/// `reserve_allocated`, `next_gate_short_by` and `last_coverage_at`. The caller
/// persists the members. Returns `remaining` (R - L) for the caller's event.
pub(crate) fn recompute_coverage(
    circle: &mut Circle,
    members: &mut [Account<'_, Member>],
    feed: &PriceFeed,
    mint_data: &[u8],
    now: i64,
) -> Result<u64> {
    let n = circle.n;
    let mut covers: Vec<u64> = Vec::with_capacity(members.len());
    let mut obligs: Vec<u64> = Vec::with_capacity(members.len());
    let mut needs: Vec<u64> = Vec::with_capacity(members.len());

    for member in members.iter() {
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
                feed,
                mint_data,
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
    }

    // R - L. Not the free figure: nothing is allocated yet at this point, and
    // this is what decides what free becomes.
    let remaining = circle.reserve_remaining();
    let allocated = allocate_in_turn_order(&needs, remaining);

    for (index, member) in members.iter_mut().enumerate() {
        member.allocated = allocated[index];
        member.last_coverage_bps = coverage_bps(covers[index], allocated[index], obligs[index]);
    }
    let total = checked_total(&allocated)?;

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

    circle.reserve_allocated = total;
    circle.next_gate_short_by = short_by(next_needed, remaining, circle.escrow_deficit);
    circle.last_coverage_at = now;

    Ok(remaining)
}
