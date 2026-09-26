// P0.3 spike only (branch spike/P0-pyth-sdk, never merged): proves pyth-solana-receiver-sdk 2.0.0
// compiles against this program's anchor-lang 1.1.2, i.e. Account<PriceUpdateV2> satisfies our
// Anchor's Owner/AccountDeserialize traits and get_price_no_older_than links into the .so.
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

#[derive(Accounts)]
pub struct PythSpike<'info> {
    pub price_update: Account<'info, PriceUpdateV2>,
}

pub fn handle_pyth_spike(ctx: Context<PythSpike>, feed_id: [u8; 32], max_age: u64) -> Result<i64> {
    let clock = Clock::get()?;
    let p = ctx.accounts.price_update.get_price_no_older_than(&clock, max_age, &feed_id)?;
    msg!("price={} conf={} expo={} publish={}", p.price, p.conf, p.exponent, p.publish_time);
    Ok(p.price)
}
