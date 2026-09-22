//! `quote_valuation`: the read-only valuation quote (T05, SPEC §5).
//!
//! Anyone may call it, it moves nothing, and it is the instruction the UI and
//! the split lab read. The valuation itself lives in `valuation::value_position`
//! because gate 2 needs the same sequence in `join_and_lock`, `release_pot` and
//! `update_coverage`; what is here is only this instruction's own preconditions.

use anchor_lang::prelude::*;

use crate::allowlist;
use crate::errors::OthelloError;
use crate::state::PriceFeed;
use crate::valuation::{value_position, Valuation};

#[derive(Accounts)]
pub struct QuoteValuation<'info> {
    /// CHECK: constrained to the feed's own mint by the seeds and `has_one`.
    pub stock_mint: UncheckedAccount<'info>,
    #[account(
        seeds = [PriceFeed::SEED, stock_mint.key().as_ref()],
        bump = feed.bump,
        has_one = stock_mint,
    )]
    pub feed: Account<'info, PriceFeed>,
}

/// `haircut_bps` and `max_price_age` are arguments rather than accounts.
///
/// SPEC §5 writes the signature as `quote_valuation(raw)` with accounts
/// "mint + feed", but `h` is defined in terms of `haircut_bps` and the
/// `price_stale` refusal in terms of `max_price_age`, and neither is reachable
/// from a mint or a feed: both live on `Circle`. The pack under-lists argument
/// lists elsewhere too, so this reads it as under-listing rather than as a
/// contradiction. Recorded in OPEN-QUESTIONS for the design session.
pub fn handle_quote_valuation(
    ctx: Context<QuoteValuation>,
    raw: u64,
    haircut_bps: u16,
    max_price_age: i64,
) -> Result<Valuation> {
    require!(max_price_age > 0, OthelloError::InvalidParams);

    // ADR-012, checked again here rather than trusted from feed creation:
    // quoting a value for a mint Othello would not accept as collateral says it
    // is acceptable collateral.
    require!(
        allowlist::is_allowed(&ctx.accounts.stock_mint.key()),
        OthelloError::MintNotAllowed
    );

    let mint_data = ctx.accounts.stock_mint.try_borrow_data()?;

    value_position(
        &ctx.accounts.feed,
        &mint_data,
        raw,
        haircut_bps,
        Clock::get()?.unix_timestamp,
        max_price_age,
    )
}
