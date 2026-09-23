//! The payout gate (T10, SPEC §5 "Payout gate", option B).
//!
//! This is the arithmetic that decides whether a pot may be released, and it is
//! the same arithmetic `update_coverage` runs in T11 and `declare_default` in
//! T15. It lives here so there is exactly one of it: three copies of a rounding
//! rule is three chances for one of them to round the protocol's way.
//!
//! SPEC §4's derived block, verbatim, is what these functions implement:
//!
//!   O_i    = received_i ? contribution x (n - rounds_paid_i) : 0
//!   need_i = max(0, ceil(O_i x coverage_bps / 10000) - H_i)
//!
//! Obligations round UP and collateral rounds DOWN, both against the member and
//! for the protocol, per SPEC §1 NFR-1. Every intermediate is u128: O x coverage
//! passes 2^64 for ordinary demo numbers long before anything looks unusual.

use anchor_lang::prelude::*;

use crate::errors::OthelloError;
use crate::valuation::BPS_DENOMINATOR;

/// What a member still owes, in usdc.
///
/// Zero until they have received their pot. KNOWN-LIMITS L3: Othello cannot
/// default a member before their turn, so before it they owe the circle
/// nothing that collateral has to stand behind.
pub fn obligations(contribution: u64, n: u8, rounds_paid: u8, received: bool) -> Result<u64> {
    if !received {
        return Ok(0);
    }
    let remaining = (n as u64).saturating_sub(rounds_paid as u64);

    contribution
        .checked_mul(remaining)
        .ok_or(OthelloError::ValuationOverflow.into())
}

/// The obligations the gate will see once every seat has paid the coming round.
///
/// SPEC §5 is explicit that this uses `c x (n - round - 1)` and NEVER the
/// stored `rounds_paid` (r4): `next_gate_short_by` is a statement about the
/// next gate, and the next gate runs after contributions that have not happened
/// yet. Reading rounds_paid here would describe the gate that just passed.
pub fn obligations_next_round(contribution: u64, n: u8, round: u8) -> Result<u64> {
    let remaining = (n as u64).saturating_sub(round as u64).saturating_sub(1);

    contribution
        .checked_mul(remaining)
        .ok_or(OthelloError::ValuationOverflow.into())
}

/// `need_i`: the reserve this member needs to reach the coverage target.
///
/// Ceils, so a requirement is never rounded below what it is.
pub fn need(obligations: u64, stock_cover: u64, coverage_bps: u16) -> Result<u64> {
    if obligations == 0 {
        return Ok(0);
    }

    let required = (obligations as u128)
        .checked_mul(coverage_bps as u128)
        .ok_or(OthelloError::ValuationOverflow)?
        .div_ceil(BPS_DENOMINATOR as u128);

    let gap = required.saturating_sub(stock_cover as u128);

    u64::try_from(gap).map_err(|_| OthelloError::ValuationOverflow.into())
}

/// `last_coverage_bps`, saturating.
///
/// SPEC.md:70: `u32::MAX` when nothing is owed, which the UI renders as
/// "Nothing owed" and never as a percentage. Dividing by O would be a panic
/// exactly when a member is in the safest state they can be in.
pub fn coverage_bps(stock_cover: u64, allocated: u64, obligations: u64) -> u32 {
    if obligations == 0 {
        return u32::MAX;
    }

    let covered = (stock_cover as u128).saturating_add(allocated as u128);
    let bps = covered
        .saturating_mul(BPS_DENOMINATOR as u128)
        .saturating_div(obligations as u128);

    u32::try_from(bps).unwrap_or(u32::MAX)
}

/// What the gate decided, and the numbers a refusal has to carry.
///
/// SPEC §5 requires every refusal to name both sides, so the UI can say who can
/// fix it and by how much (NFR-2). A bare error code would make the Paused
/// screen guess.
#[derive(Clone, Copy, Debug)]
pub struct GateOutcome {
    /// `S`, the uncapped sum of need_i over received, non-defaulted members.
    pub needed: u64,
    /// `avail`, which SPEC.md:126 calls the gate's `remaining`: R - L.
    pub remaining: u64,
    /// `need_r` for the recipient alone.
    pub recipient_gap: u64,
    /// `H_r`, so copy can say whether the recipient's own stock is the problem.
    pub recipient_cover: u64,
    pub escrow_deficit: u64,
}

impl GateOutcome {
    pub fn passes(&self) -> bool {
        self.needed <= self.remaining
    }

    /// Top-ups fill the escrow deficit first, so the ask includes it.
    pub fn short_by(&self) -> u64 {
        self.needed
            .saturating_sub(self.remaining)
            .saturating_add(self.escrow_deficit)
    }

    pub fn others_need(&self) -> u64 {
        self.needed.saturating_sub(self.recipient_gap)
    }

    /// SPEC §5: `coverage_too_low` iff the recipient's own stock is under the
    /// join minimum AND everyone else's need fits. That conjunction is what
    /// makes the copy honest: it leads with "lock more stock" only when locking
    /// more stock would actually release the pot.
    pub fn refusal(&self, min_stock_cover: u64) -> OthelloError {
        if self.recipient_cover < min_stock_cover && self.others_need() <= self.remaining {
            OthelloError::CoverageTooLow
        } else {
            OthelloError::ReserveOvercommitted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;
    /// SPEC.md:134's demo circle.
    const N: u8 = 5;
    const CONTRIBUTION: u64 = 50 * USDC;
    const COVERAGE_BPS: u16 = 13_000;
    const MIN_STOCK_COVER: u64 = 120 * USDC;

    /// SPEC.md:133 states the table as "needs 140, 150, 30, 0 -> peak 150".
    ///
    /// The create-time peak assumes every received member holds exactly
    /// min_stock_cover, so the gate at round k, with k members received and
    /// each at the minimum, must produce the same figure. If the gate and the
    /// peak check disagreed, a circle could pass creation and then pause on its
    /// own parameters.
    #[test]
    fn the_gate_reproduces_the_spec_demo_table() {
        let expected = [140 * USDC, 150 * USDC, 30 * USDC, 0];

        for (k, want) in (1..N).zip(expected) {
            // k members have received; everyone has paid k rounds.
            let o = obligations(CONTRIBUTION, N, k, true).unwrap();
            let per_member = need(o, MIN_STOCK_COVER, COVERAGE_BPS).unwrap();
            let total = per_member * k as u64;

            assert_eq!(total, want, "need_{k}");
        }
    }

    #[test]
    fn nothing_is_owed_before_a_member_has_received() {
        assert_eq!(obligations(CONTRIBUTION, N, 2, false).unwrap(), 0);
        assert_eq!(need(0, 0, COVERAGE_BPS).unwrap(), 0);
        assert_eq!(coverage_bps(0, 0, 0), u32::MAX);
    }

    #[test]
    fn the_requirement_ceils_rather_than_rounding_in_the_members_favour() {
        // 1 base unit at 130% is 1.3, which must count as 2 and not as 1.
        assert_eq!(need(1, 0, COVERAGE_BPS).unwrap(), 2);
        // And a cover that already meets it needs nothing, never a negative.
        assert_eq!(need(1, 99, COVERAGE_BPS).unwrap(), 0);
    }

    #[test]
    fn the_demo_position_needs_less_than_the_peak_assumes() {
        // The demo locks 1.1 token, H = 132, above the 120 minimum the peak
        // table assumes. So the real gate is easier than the create-time check,
        // which is the direction that keeps a created circle runnable.
        let o = obligations(CONTRIBUTION, N, 1, true).unwrap();

        assert!(
            need(o, 132 * USDC, COVERAGE_BPS).unwrap()
                < need(o, MIN_STOCK_COVER, COVERAGE_BPS).unwrap()
        );
    }

    #[test]
    fn next_round_obligations_ignore_rounds_paid() {
        // Round 1 of 5: every received member will owe c x (5 - 1 - 1) = 3c
        // once the coming round is paid, whatever rounds_paid says today.
        assert_eq!(
            obligations_next_round(CONTRIBUTION, N, 1).unwrap(),
            3 * CONTRIBUTION
        );
        // The last round leaves nothing owed, and must not underflow.
        assert_eq!(obligations_next_round(CONTRIBUTION, N, N - 1).unwrap(), 0);
        assert_eq!(obligations_next_round(CONTRIBUTION, N, 200).unwrap(), 0);
    }

    #[test]
    fn coverage_saturates_rather_than_dividing_by_zero() {
        assert_eq!(coverage_bps(100, 0, 0), u32::MAX);
        // Exactly the target reads as the target.
        let o = 100 * USDC;
        let h = 130 * USDC;
        assert_eq!(coverage_bps(h, 0, o), 13_000);
    }

    #[test]
    fn a_refusal_names_the_recipient_only_when_their_stock_is_the_whole_gap() {
        let base = GateOutcome {
            needed: 100,
            remaining: 50,
            recipient_gap: 60,
            recipient_cover: 10,
            escrow_deficit: 0,
        };

        // Recipient under the minimum, and the others fit: their stock is it.
        assert!(matches!(base.refusal(120), OthelloError::CoverageTooLow));

        // Recipient under the minimum, but the others alone already overflow
        // the reserve: locking more stock would not release the pot.
        let crowded = GateOutcome {
            recipient_gap: 10,
            ..base
        };
        assert!(matches!(
            crowded.refusal(120),
            OthelloError::ReserveOvercommitted
        ));

        // Recipient at or above the minimum is never the named cause.
        let healthy = GateOutcome {
            recipient_cover: 120,
            ..base
        };
        assert!(matches!(
            healthy.refusal(120),
            OthelloError::ReserveOvercommitted
        ));
    }

    #[test]
    fn short_by_includes_the_escrow_deficit_because_top_ups_fill_it_first() {
        let outcome = GateOutcome {
            needed: 75,
            remaining: 70,
            recipient_gap: 0,
            recipient_cover: 0,
            escrow_deficit: 9,
        };

        assert_eq!(outcome.short_by(), 14);
        assert!(!outcome.passes());
    }

    #[test]
    fn a_gate_that_exactly_meets_the_reserve_passes() {
        let outcome = GateOutcome {
            needed: 70,
            remaining: 70,
            recipient_gap: 0,
            recipient_cover: 0,
            escrow_deficit: 0,
        };

        assert!(outcome.passes(), "the comparison is <=, not <");
        assert_eq!(outcome.short_by(), 0);
    }
}
