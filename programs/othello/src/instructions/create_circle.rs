//! `create_circle` (T08, SPEC §5).
//!
//! Everything a circle can never change afterwards is fixed here: who is in it,
//! in what order, and every parameter. ADR-003 and FLOWS D3: the creator names
//! the members and the turn order, and `join_and_lock` is each member's
//! consent. There is no open join, no approval instruction and no order vote.
//!
//! The load-bearing check is the peak-guarantee one. A circle whose guarantee
//! reserve cannot cover the worst round it will reach is not a circle that
//! fails later, it is a circle that should never have been created.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::allowlist;
use crate::errors::OthelloError;
use crate::events::CircleCreated;
use crate::state::{Circle, CircleStatus, LiquidationPool, MAX_MEMBERS, MIN_MEMBERS};
use crate::valuation::BPS_DENOMINATOR;

/// Everything the creator fixes, per `design/FLOWS.md:154`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CircleParams {
    pub circle_id: u64,
    pub contribution: u64,
    pub round_secs: i64,
    pub grace_secs: i64,
    pub haircut_bps: u16,
    pub coverage_bps: u16,
    pub warn_bps: u16,
    pub guarantee_per_member: u64,
    pub min_stock_cover: u64,
    pub max_price_age: i64,
}

/// SPEC §5 parameter ranges. `round_secs >= 60`, `grace_secs >= 30`.
const MIN_ROUND_SECS: i64 = 60;
const MIN_GRACE_SECS: i64 = 30;

#[derive(Accounts)]
#[instruction(params: CircleParams)]
pub struct CreateCircle<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Circle::INIT_SPACE,
        seeds = [Circle::SEED, creator.key().as_ref(), &params.circle_id.to_le_bytes()],
        bump
    )]
    pub circle: Box<Account<'info, Circle>>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The feed's seeds bind it to `stock_mint`, so "feed matches" is structural.
    #[account(
        seeds = [crate::state::PriceFeed::SEED, stock_mint.key().as_ref()],
        bump = price_feed.bump,
        has_one = stock_mint,
    )]
    pub price_feed: Box<Account<'info, crate::state::PriceFeed>>,

    /// The pool's seeds carry BOTH mints, so "pool matches" is structural too.
    #[account(
        seeds = [LiquidationPool::SEED, usdc_mint.key().as_ref(), stock_mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LiquidationPool>>,

    // The circle's two vaults are NOT created here. T09 creates them, the way
    // SPEC §5 already creates a member's USDC ATA at `join_and_lock`: token
    // accounts are made when something first needs to move into them.
    //
    // This was tried the other way first and the real mints refused it. A
    // Token-2022 account for a mint carrying extensions needs more than the
    // base 165 bytes, and Anchor's `init` allocates the base:
    //
    //   Program log: Instruction: InitializeAccount3
    //   Program log: Warning: Mint has a permanent delegate, so tokens in this
    //                account may be seized at any time
    //   Program log: Error: InvalidAccountData
    //
    // That warning is KNOWN-LIMITS L7 observed on chain rather than assumed.
    pub system_program: Program<'info, System>,
}

/// The worst round this circle can reach, in USDC base units (SPEC §5).
///
/// For `k = 1..n-1`, with k recipients paid and everyone having paid k rounds:
/// `need_k = k x max(0, ceil(c x (n-k) x coverage_bps / 10000) - min_stock_cover)`.
/// The peak over k is what the reserve must cover.
///
/// Obligations round UP, per SPEC §4, which is why this ceils: rounding a
/// requirement down would let a circle be created that cannot meet it.
pub fn peak_guarantee_need(
    n: u8,
    contribution: u64,
    coverage_bps: u16,
    min_stock_cover: u64,
) -> Result<u128> {
    let mut peak: u128 = 0;

    for k in 1..n as u128 {
        let remaining_rounds = n as u128 - k;

        let obligations = (contribution as u128)
            .checked_mul(remaining_rounds)
            .and_then(|v| v.checked_mul(coverage_bps as u128))
            .ok_or(OthelloError::ValuationOverflow)?;

        let required = obligations.div_ceil(BPS_DENOMINATOR as u128);
        let gap = required.saturating_sub(min_stock_cover as u128);

        let need = k.checked_mul(gap).ok_or(OthelloError::ValuationOverflow)?;

        peak = peak.max(need);
    }

    Ok(peak)
}

pub fn handle_create_circle(
    ctx: Context<CreateCircle>,
    params: CircleParams,
    members: Vec<Pubkey>,
) -> Result<()> {
    let n = members.len();

    require!(
        (MIN_MEMBERS..=MAX_MEMBERS).contains(&n),
        OthelloError::InvalidParams
    );

    // ADR-003 / FLOWS D3: the creator names the members, and must be one.
    require!(
        members.contains(&ctx.accounts.creator.key()),
        OthelloError::InvalidParams
    );

    // Unique wallets. Two seats held by one wallet would let one member take
    // two payouts and count one guarantee twice.
    for (index, member) in members.iter().enumerate() {
        require!(*member != Pubkey::default(), OthelloError::InvalidParams);
        require!(
            !members[..index].contains(member),
            OthelloError::InvalidParams
        );
    }

    // ADR-012. Collateral is identified by mint address, never by symbol.
    require!(
        allowlist::is_allowed(&ctx.accounts.stock_mint.key()),
        OthelloError::MintNotAllowed
    );

    // SPEC §5 parameter ranges, in the order SPEC lists them.
    require!(params.contribution > 0, OthelloError::InvalidParams);
    require!(params.guarantee_per_member > 0, OthelloError::InvalidParams);
    require!(
        (params.haircut_bps as u64) < BPS_DENOMINATOR,
        OthelloError::InvalidParams
    );
    require!(
        params.coverage_bps as u64 >= BPS_DENOMINATOR,
        OthelloError::InvalidParams
    );
    require!(
        params.warn_bps as u64 >= BPS_DENOMINATOR && params.warn_bps < params.coverage_bps,
        OthelloError::InvalidParams
    );
    require!(
        params.round_secs >= MIN_ROUND_SECS,
        OthelloError::InvalidParams
    );
    require!(
        params.grace_secs >= MIN_GRACE_SECS,
        OthelloError::InvalidParams
    );
    // SPEC §5 gives these two a floor and no ceiling, which is enough for a
    // policy and not enough to be representable. `activate` computes
    // `now + round_secs` and T15 will compute `deadline + grace_secs`, so a
    // round of i64::MAX passes creation, accepts every join, and then fails on
    // the addition, after five people have locked their stock.
    //
    // This bound is not a maximum round length, which would be a design
    // decision and is not the build's to make. It is the weakest condition
    // under which the arithmetic cannot overflow: with both under half the
    // range, `now + round_secs + grace_secs` is representable for any `now` in
    // the lower half, which is every timestamp this chain will ever carry.
    require!(
        params
            .round_secs
            .checked_add(params.grace_secs)
            .is_some_and(|total| total <= i64::MAX / 2),
        OthelloError::InvalidParams
    );
    require!(params.max_price_age > 0, OthelloError::InvalidParams);
    // So H can never exceed what liquidation would actually return.
    require!(
        ctx.accounts.pool.discount_bps <= params.haircut_bps,
        OthelloError::InvalidParams
    );

    // The peak-guarantee check. SPEC §3's table, computed on chain.
    let peak = peak_guarantee_need(
        n as u8,
        params.contribution,
        params.coverage_bps,
        params.min_stock_cover,
    )?;
    let reserve = (n as u128)
        .checked_mul(params.guarantee_per_member as u128)
        .ok_or(OthelloError::ValuationOverflow)?;

    require!(reserve >= peak, OthelloError::GuaranteeBelowPeakNeed);

    // The peak check compares in u128, but `reserve_total` and `deposits_total`
    // are u64 and the guarantees all land in ONE token account, whose amount is
    // also a u64. So a reserve that satisfies the peak in u128 can still be a
    // total no field can hold.
    //
    // The failure is not an arithmetic one that checked_add catches. It is a
    // circle that is created, takes its first guarantee, and then refuses every
    // later join for ever: it can never reach Active, and the money that is
    // already in it can only come back through a creator cancellation. Refusing
    // here is the difference between an invalid configuration and a trap.
    require!(
        params.guarantee_per_member <= u64::MAX / n as u64,
        OthelloError::InvalidParams
    );

    let circle = &mut ctx.accounts.circle;

    circle.creator = ctx.accounts.creator.key();
    circle.circle_id = params.circle_id;
    circle.bump = ctx.bumps.circle;

    circle.stock_mint = ctx.accounts.stock_mint.key();
    circle.usdc_mint = ctx.accounts.usdc_mint.key();
    circle.price_feed = ctx.accounts.price_feed.key();
    circle.pool = ctx.accounts.pool.key();

    circle.n = n as u8;
    circle.members = [Pubkey::default(); MAX_MEMBERS];
    circle.members[..n].copy_from_slice(&members);

    circle.contribution = params.contribution;
    circle.round_secs = params.round_secs;
    circle.grace_secs = params.grace_secs;
    circle.haircut_bps = params.haircut_bps;
    circle.coverage_bps = params.coverage_bps;
    circle.warn_bps = params.warn_bps;
    circle.guarantee_per_member = params.guarantee_per_member;
    circle.min_stock_cover = params.min_stock_cover;
    circle.max_price_age = params.max_price_age;

    // SPEC names no initial value for the rest. Zero, and Forming, is what
    // makes I2, I3 and I4 hold from this instruction on: nothing is allocated,
    // nothing is deposited, and both vaults are empty. `activate` sets round 0
    // and the deadline (SPEC §5), so the deadline stays 0 while Forming.
    circle.status = CircleStatus::Forming;
    circle.round = 0;
    circle.round_deadline = 0;
    circle.paid_bitmap = 0;
    circle.joined_bitmap = 0;
    circle.withdrawn_bitmap = 0;
    circle.received_bitmap = 0;
    circle.defaulted_bitmap = 0;
    circle.reserve_total = 0;
    circle.reserve_losses = 0;
    circle.reserve_allocated = 0;
    circle.escrow = 0;
    circle.escrow_deficit = 0;
    circle.withdrawn_usdc = 0;
    circle.deposits_total = 0;
    circle.forfeited_total = 0;
    circle.next_gate_short_by = 0;
    circle.held_contributions = 0;
    circle.last_coverage_at = 0;

    emit!(CircleCreated {
        circle: circle.key(),
        creator: circle.creator,
        circle_id: circle.circle_id,
        n: circle.n,
        stock_mint: circle.stock_mint,
        usdc_mint: circle.usdc_mint,
        contribution: circle.contribution,
        guarantee_per_member: circle.guarantee_per_member,
        peak_guarantee_need: u64::try_from(peak).unwrap_or(u64::MAX),
        status: circle.status,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC §5's demo circle, in USDC base units: n = 5, c = 50, coverage 130%,
    /// min stock cover 120.
    const N: u8 = 5;
    const USDC: u64 = 1_000_000;
    const CONTRIBUTION: u64 = 50 * USDC;
    const COVERAGE_BPS: u16 = 13_000;
    const MIN_STOCK_COVER: u64 = 120 * USDC;

    /// SPEC §5 states the answer: "Demo: n=5, c=50, cov 130%, min cover 120 ->
    /// needs 140, 150, 30, 0 -> peak 150". This reproduces the table term by
    /// term rather than only its maximum, so a decoder that got the peak right
    /// by accident would still fail.
    #[test]
    fn peak_reproduces_the_spec_demo_table() {
        let expected_per_k = [140 * USDC, 150 * USDC, 30 * USDC, 0];

        for (index, expected) in expected_per_k.iter().enumerate() {
            let k = index as u8 + 1;

            // The peak over 1..=k is the running maximum, so the k-th term is
            // recoverable as the difference between two prefixes only when it
            // is the largest so far. Compute the term directly instead.
            let remaining = (N - k) as u128;
            let required = (CONTRIBUTION as u128 * remaining * COVERAGE_BPS as u128)
                .div_ceil(BPS_DENOMINATOR as u128);
            let need = k as u128 * required.saturating_sub(MIN_STOCK_COVER as u128);

            assert_eq!(need, *expected as u128, "need_{k}");
        }

        assert_eq!(
            peak_guarantee_need(N, CONTRIBUTION, COVERAGE_BPS, MIN_STOCK_COVER).unwrap(),
            150 * USDC as u128,
            "the peak is the largest term"
        );
    }

    /// The smallest circle SPEC allows, at the demo's other parameters.
    ///
    /// k = 1: the member who received still owes TWO rounds, so
    /// ceil(50 x 2 x 1.3) = 130 against a 120 minimum, a gap of 10.
    /// k = 2: one round, ceil(50 x 1.3) = 65, under the minimum, so 0.
    ///
    /// Pinned because a comment in tests/t09b-leave-forming.spec.ts once said
    /// this peak was 0, by counting one remaining round instead of two at
    /// k = 1. The gate 2 re-review caught it. A number that only lives in a
    /// comment is a number nothing checks.
    #[test]
    fn peak_for_the_smallest_circle_is_ten() {
        assert_eq!(
            peak_guarantee_need(3, CONTRIBUTION, COVERAGE_BPS, MIN_STOCK_COVER).unwrap(),
            10 * USDC as u128,
        );
    }

    /// T08's done-when: g = 29 is refused, g = 30 is not. 5 x 30 = 150 exactly
    /// meets the peak, so this also pins the comparison as `>=` not `>`.
    #[test]
    fn peak_is_the_boundary_between_g29_and_g30() {
        let peak = peak_guarantee_need(N, CONTRIBUTION, COVERAGE_BPS, MIN_STOCK_COVER).unwrap();

        assert!(
            (N as u128) * (29 * USDC as u128) < peak,
            "g = 29 must not reach the peak"
        );
        assert_eq!(
            (N as u128) * (30 * USDC as u128),
            peak,
            "g = 30 must meet it exactly"
        );
    }

    /// Obligations round UP (SPEC §4). A coverage that divides unevenly must
    /// not let a circle be created that cannot meet its own requirement.
    #[test]
    fn peak_ceils_the_coverage_requirement() {
        // 1 base unit x 1 round x 10001 bps = 10001, which is 1.0001 units.
        // Floor would say 1 and leave the circle a hundredth of a unit short.
        let peak = peak_guarantee_need(2, 1, 10_001, 0).unwrap();

        assert_eq!(peak, 2, "ceil(10001/10000) = 2, floored would be 1");
    }

    /// `min_stock_cover` above the requirement means the stock covers it all,
    /// and the reserve needs nothing. Saturating, never negative.
    #[test]
    fn peak_is_zero_when_stock_cover_exceeds_every_obligation() {
        let peak = peak_guarantee_need(N, CONTRIBUTION, COVERAGE_BPS, 10_000 * USDC).unwrap();

        assert_eq!(peak, 0);
    }

    /// The `checked_mul`s in `peak_guarantee_need` cannot fire for any input
    /// the type signature admits, and this proves it rather than asserting it.
    ///
    /// The largest product is `contribution x (n-1) x coverage_bps`, bounded by
    /// `u64::MAX x 7 x u16::MAX`, about 8.5e24 against u128's 3.4e38. The
    /// guards stay because they are free and because a later change to a wider
    /// `contribution` would need them, but nothing in range reaches them.
    #[test]
    fn peak_cannot_overflow_for_any_input_the_types_admit() {
        let widest = (u64::MAX as u128) * (MAX_MEMBERS as u128 - 1) * (u16::MAX as u128);

        assert!(widest < u128::MAX / 8, "the bound argument no longer holds");

        // Every extreme the signature allows, and none of them errors.
        for n in MIN_MEMBERS as u8..=MAX_MEMBERS as u8 {
            assert!(peak_guarantee_need(n, u64::MAX, u16::MAX, 0).is_ok());
            assert!(peak_guarantee_need(n, u64::MAX, u16::MAX, u64::MAX).is_ok());
            assert!(peak_guarantee_need(n, 0, 0, 0).is_ok());
        }
    }

    /// A one-member or zero-member circle never reaches the loop. The range
    /// check in the handler refuses those separately; this pins that the
    /// arithmetic is total rather than accidentally undefined there.
    #[test]
    fn peak_of_a_circle_with_no_second_member_is_zero() {
        assert_eq!(
            peak_guarantee_need(1, CONTRIBUTION, COVERAGE_BPS, 0).unwrap(),
            0
        );
        assert_eq!(
            peak_guarantee_need(0, CONTRIBUTION, COVERAGE_BPS, 0).unwrap(),
            0
        );
    }
}
