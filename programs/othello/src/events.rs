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
