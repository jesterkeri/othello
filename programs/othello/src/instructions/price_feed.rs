//! The PriceFeed: the only place a price enters the program (T04).
//!
//! Othello never reads a price oracle. On devnet the demo admin sets prices and
//! the program's job is to make sure a price can never be bound to the wrong
//! multiplier. That is D5 / ADR-010 / I13, and it is what stops a 10-for-1
//! split from looking like a 90% crash.

use anchor_lang::prelude::*;

use crate::allowlist;
use crate::errors::OthelloError;
use crate::events::PricesSet;
use crate::state::{PriceFeed, PriceStamp};
use crate::valuation::{decode_multiplier_fixed, effective_multiplier_bits, scaled_ui_config};

#[derive(Accounts)]
pub struct InitPriceFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// `authority` must be the admin: the program's upgrade authority. `init_pool`
    /// uses the same two accounts for the same reason.
    ///
    /// This is the bootstrap root the oracle-takeover finding asked for (T04
    /// adversary, Codex 2026-09-22). Before it, `init_price_feed` made whoever
    /// called it first the authority of that mint's feed, permanently, and the
    /// feed's prices are what every valuation reads. A first-caller-wins
    /// initializer cannot be part of a deployed trust model.
    ///
    /// The upgrade authority is the key that deploys the program, so it needs no
    /// new key, no config account and no setup transaction, and there is no window
    /// between deploy and first use for anyone else to take. It is read from the
    /// loader's own ProgramData account, which the program cannot be handed a fake
    /// of: `program` must be this program, its ProgramData address is derived from
    /// that, and the upgradeable loader owns it. A program deployed immutable has
    /// no upgrade authority, and then nobody is the admin, which is refused.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ OthelloError::Unauthorized)]
    pub program: Program<'info, crate::program::Othello>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ OthelloError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    /// CHECK: read only, and only to bind the feed's PDA to a mint. The handler
    /// refuses any mint outside the ADR-012 allowlist.
    pub stock_mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [PriceFeed::SEED, stock_mint.key().as_ref()],
        bump
    )]
    pub feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrices<'info> {
    pub authority: Signer<'info>,
    /// CHECK: constrained to the feed's own mint by the seeds below, and parsed
    /// as a Token-2022 mint in the handler.
    pub stock_mint: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [PriceFeed::SEED, stock_mint.key().as_ref()],
        bump = feed.bump,
        has_one = authority @ OthelloError::Unauthorized,
        has_one = stock_mint,
    )]
    pub feed: Account<'info, PriceFeed>,
}

#[derive(Accounts)]
pub struct TouchPrices<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PriceFeed::SEED, feed.stock_mint.as_ref()],
        bump = feed.bump,
        has_one = authority @ OthelloError::Unauthorized,
    )]
    pub feed: Account<'info, PriceFeed>,
}

pub fn handle_init_price_feed(ctx: Context<InitPriceFeed>) -> Result<()> {
    // ADR-012. A feed is where a mint first enters the program, so refusing
    // here keeps every later instruction from having to wonder.
    require!(
        allowlist::is_allowed(&ctx.accounts.stock_mint.key()),
        OthelloError::MintNotAllowed
    );

    let feed = &mut ctx.accounts.feed;

    feed.authority = ctx.accounts.authority.key();
    feed.stock_mint = ctx.accounts.stock_mint.key();
    feed.bump = ctx.bumps.feed;
    feed.wrapper_price = 0;
    feed.share_price = 0;
    feed.priced_for_multiplier = 0;
    feed.updated_at = 0;

    Ok(())
}

/// The multiplier a given stamp would bind these prices to, read from the mint.
fn multiplier_for_stamp(mint_data: &[u8], stamp: PriceStamp, now: i64) -> Result<u64> {
    let config = scaled_ui_config(mint_data)?;

    let bits = match stamp {
        PriceStamp::Current => effective_multiplier_bits(&config, now),
        PriceStamp::Scheduled => u64::from_le_bytes(config.new_multiplier.0),
    };

    decode_multiplier_fixed(bits)
}

/// True when the feed already carries a scheduled stamp that has not arrived.
fn scheduled_stamp_pending(feed: &PriceFeed, mint_data: &[u8], now: i64) -> Result<bool> {
    let config = scaled_ui_config(mint_data)?;

    // A new_multiplier that will not decode means nothing is pending, rather
    // than meaning this call fails. `feed.priced_for_multiplier` only ever holds
    // a value that DID decode, so it can never equal an undecodable one; and
    // refusing here would make a mint with a malformed scheduled multiplier
    // unpriceable for its perfectly readable current one.
    let Ok(scheduled) = decode_multiplier_fixed(u64::from_le_bytes(config.new_multiplier.0)) else {
        return Ok(false);
    };
    let effective_at: i64 = config.new_multiplier_effective_timestamp.into();

    Ok(feed.priced_for_multiplier == scheduled && effective_at > now)
}

pub fn handle_set_prices(
    ctx: Context<SetPrices>,
    wrapper_price: u64,
    share_price: u64,
    stamp: PriceStamp,
    expected_multiplier_fixed: u64,
) -> Result<()> {
    require!(
        wrapper_price > 0 && share_price > 0,
        OthelloError::InvalidParams
    );

    let now = Clock::get()?.unix_timestamp;
    let mint_data = ctx.accounts.stock_mint.try_borrow_data()?;

    // The script states which multiplier these prices are for; the program
    // verifies it rather than trusting it. Without this a share price quoted
    // before a split can be stamped as if it were quoted after one (I17).
    let stamped = multiplier_for_stamp(&mint_data, stamp, now)?;
    require!(
        stamped == expected_multiplier_fixed,
        OthelloError::MultiplierPriceMismatch
    );

    // Refuse to walk a pending Scheduled stamp back to Current. The prices
    // already on the feed are the post-change ones, and re-stamping them as
    // Current would bind a post-split share price to the pre-split multiplier.
    if stamp == PriceStamp::Current && scheduled_stamp_pending(&ctx.accounts.feed, &mint_data, now)?
    {
        return err!(OthelloError::MultiplierPriceMismatch);
    }

    drop(mint_data);

    let feed = &mut ctx.accounts.feed;
    feed.wrapper_price = wrapper_price;
    feed.share_price = share_price;
    feed.priced_for_multiplier = stamped;
    feed.updated_at = now;

    emit!(PricesSet {
        feed: feed.key(),
        stock_mint: feed.stock_mint,
        wrapper_price: feed.wrapper_price,
        share_price: feed.share_price,
        priced_for_multiplier: feed.priced_for_multiplier,
        updated_at: feed.updated_at,
    });

    Ok(())
}

/// Only `updated_at` moves. Prices and the stamp are untouched (I17).
///
/// The refresh script calls this and never `set_prices`, so keeping a demo
/// alive can never re-bind a price to a different multiplier by accident.
pub fn handle_touch_prices(ctx: Context<TouchPrices>) -> Result<()> {
    ctx.accounts.feed.updated_at = Clock::get()?.unix_timestamp;

    Ok(())
}
