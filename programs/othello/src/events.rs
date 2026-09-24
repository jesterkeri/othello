//! One event per state change.
//!
//! `ARCHITECTURE.md:85`, the STRIDE table, lists repudiation as a threat and
//! names the answer: `CircleCreated, MemberJoined, Activated, Contributed,
//! PotReleased, CoverageUpdated, DefaultDeclared, ReserveToppedUp, StockAdded,
//! Withdrawn, PricesSet`. Gate 1 emitted none of them; that was found by the
//! T08 scout pass and is recorded in OPEN-QUESTIONS. Each event lands with the
//! instruction that causes its state change.

use anchor_lang::prelude::*;

use crate::state::CircleStatus;

#[event]
pub struct CircleCreated {
    pub circle: Pubkey,
    pub creator: Pubkey,
    pub circle_id: u64,
    pub n: u8,
    pub stock_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub contribution: u64,
    pub guarantee_per_member: u64,
    /// The worst round this circle can reach, from the peak-guarantee check.
    pub peak_guarantee_need: u64,
    pub status: CircleStatus,
}

/// `set_prices` (T04). Added at T08 with the rest of the event surface, so the
/// gate-1 review predates it; nothing about the refusals or the arithmetic
/// changed.
#[event]
pub struct PricesSet {
    pub feed: Pubkey,
    pub stock_mint: Pubkey,
    pub wrapper_price: u64,
    pub share_price: u64,
    pub priced_for_multiplier: u64,
    pub updated_at: i64,
}

/// T09. ARCHITECTURE:85 requires an event per state change.
#[event]
pub struct MemberJoined {
    pub circle: Pubkey,
    pub member: Pubkey,
    pub wallet: Pubkey,
    pub turn: u8,
    pub stock_raw: u64,
    /// H at the moment of joining, so an indexer can see the join cleared the
    /// minimum without re-deriving it from prices that have since moved.
    pub stock_cover: u64,
    pub guarantee: u64,
    pub joined_bitmap: u8,
}

#[event]
pub struct CircleActivated {
    pub circle: Pubkey,
    pub round: u8,
    pub round_deadline: i64,
    pub reserve_total: u64,
}

#[event]
pub struct CircleCancelled {
    pub circle: Pubkey,
    pub joined_bitmap: u8,
    pub reserve_total: u64,
}

/// T10.
#[event]
pub struct Contributed {
    pub circle: Pubkey,
    pub member: Pubkey,
    pub turn: u8,
    pub round: u8,
    pub amount: u64,
    pub paid_bitmap: u8,
    pub held_contributions: u64,
}

#[event]
pub struct PotReleased {
    pub circle: Pubkey,
    pub round: u8,
    pub recipient: Pubkey,
    pub pot: u64,
    /// The gate's own numbers, so an indexer can show why it passed.
    pub needed: u64,
    pub remaining: u64,
    pub reserve_allocated: u64,
    pub next_gate_short_by: u64,
    pub completed: bool,
}

/// T11.
#[event]
pub struct CoverageUpdated {
    pub circle: Pubkey,
    pub round: u8,
    pub reserve_allocated: u64,
    /// R - L at the moment of the recompute, so an indexer can see the ratio.
    pub remaining: u64,
    pub next_gate_short_by: u64,
    pub last_coverage_at: i64,
}

/// T12.
#[event]
pub struct Withdrawn {
    pub circle: Pubkey,
    pub member: Pubkey,
    pub wallet: Pubkey,
    pub turn: u8,
    pub usdc: u64,
    pub stock: u64,
    pub withdrawn_bitmap: u8,
    pub withdrawn_usdc: u64,
}

/// SPEC.md:204: "Every refusal payload field named in section 5 is emitted as
/// an event before the error returns, so the UI can print the numbers."
///
/// These two exist because a `msg!` line is not an event. Both reach the client
/// through the same transaction logs, but an event is typed, declared in the
/// IDL and decoded by the client library, while a log line is free text the
/// client has to parse by hand and that no schema protects. FLOWS §9 has every
/// transaction previewed by simulation, and a simulated failure returns its
/// logs, so a refusal event is readable without the transaction ever landing.
///
/// This is why NFR-2 exists: a Paused screen that cannot name what it is short
/// by is a screen that tells someone to go and find out.
#[event]
pub struct PotRefused {
    pub circle: Pubkey,
    pub round: u8,
    pub recipient: Pubkey,
    /// `S`, the uncapped sum of need_i.
    pub needed: u64,
    /// `R - L`, which SPEC.md:126 calls the gate's `remaining`.
    pub remaining: u64,
    pub short_by: u64,
    pub recipient_gap: u64,
    pub others_need: u64,
    pub recipient_cover: u64,
    pub escrow_deficit: u64,
    /// True when the recipient's own stock is the whole gap, which is the only
    /// case where "lock more stock" is advice that would work.
    pub coverage_too_low: bool,
}

/// SPEC.md:106's payload:
/// `round_not_funded{missing_seats, escrow, escrow_needed, escrow_deficit, short_by}`.
#[event]
pub struct RoundNotFunded {
    pub circle: Pubkey,
    pub round: u8,
    /// Bitmap of seats that have neither paid nor defaulted.
    pub missing_seats: u8,
    pub escrow: u64,
    /// `k x contribution`, what the escrow must hold to cover defaulted seats.
    pub escrow_needed: u64,
    pub escrow_deficit: u64,
    pub short_by: u64,
}

/// The G2 repair (2026-09-24). A member unwinding their own join before the
/// circle activates, which is the only way out of a Forming circle that does
/// not depend on the creator acting.
#[event]
pub struct MemberLeftForming {
    pub circle: Pubkey,
    pub wallet: Pubkey,
    pub turn: u8,
    pub stock: u64,
    pub usdc: u64,
    pub joined_bitmap: u8,
    pub reserve_total: u64,
    pub deposits_total: u64,
}

/// T14. The pool that buys seized stock, and the discount it buys at.
#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub stock_mint: Pubkey,
    pub discount_bps: u16,
}

/// T14. `pool_usdc` is the vault's balance after the seed, which is what
/// `declare_default` checks `recovered` against (`pool_insufficient`).
#[event]
pub struct PoolSeeded {
    pub pool: Pubkey,
    pub amount: u64,
    pub pool_usdc: u64,
}
