use anchor_lang::prelude::*;

/// Which multiplier a price was quoted against (SPEC §5, ADR-010).
///
/// The script says which one it means and the program verifies it, rather than
/// the program guessing. That is the whole of D5: a share price quoted for the
/// old multiplier must never be stamped as if it were quoted for the new one.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PriceStamp {
    /// The multiplier in force right now, by the Clock.
    Current,
    /// The multiplier that takes effect at `new_multiplier_effective_timestamp`.
    Scheduled,
}

#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub authority: Pubkey,
    pub stock_mint: Pubkey,
    pub bump: u8,
    /// Price of one whole raw token, NOT scaled (SPEC §4).
    pub wrapper_price: u64,
    /// Price of one underlying share.
    pub share_price: u64,
    /// The multiplier `share_price` was quoted against, fixed ×1e9 (D5).
    pub priced_for_multiplier: u64,
    pub updated_at: i64,
}

impl PriceFeed {
    pub const SEED: &'static [u8] = b"price";
}
