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
