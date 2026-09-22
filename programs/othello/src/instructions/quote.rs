//! `quote_valuation`: the read-only valuation quote (T05, SPEC §5).
//!
//! Anyone may call it, it moves nothing, and it is the instruction the UI and
//! the split lab read. It is also where D5 is enforced for valuation: if the
//! feed's stamp does not match the multiplier in force, the position is
//! Repricing and this refuses rather than returning a number that is wrong by
//! the size of the split.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Mint as MintState,
};

use crate::errors::OthelloError;
use crate::state::PriceFeed;
use crate::valuation::{
    counted_value, decode_multiplier_fixed, effective_multiplier_bits, exec_value, fund_value,
    Valuation,
};

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
/// `price_stale` refusal is defined in terms of `max_price_age`, and neither is
/// reachable from a mint or a feed: both live on `Circle`. The pack under-lists
/// argument lists elsewhere too, so this reads it as under-listing rather than
/// as a contradiction. Recorded in OPEN-QUESTIONS for the design session.
pub fn handle_quote_valuation(
    ctx: Context<QuoteValuation>,
    raw: u64,
    haircut_bps: u16,
    max_price_age: i64,
) -> Result<Valuation> {
    require!(max_price_age > 0, OthelloError::InvalidParams);

    let feed = &ctx.accounts.feed;
    let now = Clock::get()?.unix_timestamp;

    // Freshness, SPEC §5: fresh iff now - updated_at <= max_price_age. A feed
    // that has never been priced has updated_at 0 and fails this on any real
    // clock, which is the intent: an unpriced feed values nothing.
    let age = now
        .checked_sub(feed.updated_at)
        .ok_or(OthelloError::PriceStale)?;
    require!(age <= max_price_age, OthelloError::PriceStale);
    require!(
        feed.wrapper_price > 0 && feed.share_price > 0,
        OthelloError::PriceStale
    );

    let mint_data = ctx.accounts.stock_mint.try_borrow_data()?;
    let mint = StateWithExtensions::<MintState>::unpack(&mint_data)
        .map_err(|_| error!(OthelloError::MultiplierInvalid))?;
    let config = mint
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| error!(OthelloError::MultiplierInvalid))?;

    let mult_fixed = decode_multiplier_fixed(effective_multiplier_bits(config, now))?;

    // D5 / I13. The share price was quoted against SOME multiplier and the feed
    // records which. If that is not the one in force, the position is Repricing
    // and FUND would be wrong by the whole size of the split.
    require!(
        feed.priced_for_multiplier == mult_fixed,
        OthelloError::MultiplierPriceMismatch
    );

    let fund = fund_value(raw, mult_fixed, feed.share_price)?;
    let exec = exec_value(raw, feed.wrapper_price)?;
    let h = counted_value(fund, exec, haircut_bps)?;

    Ok(Valuation {
        mult_fixed,
        fund,
        exec,
        h,
    })
}
