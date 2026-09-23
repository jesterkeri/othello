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

/// SPEC §4. A circle's lifecycle.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CircleStatus {
    Forming,
    Active,
    Completed,
    Cancelled,
}

/// The most members a circle can have (SPEC §4, `members: [Pubkey; 8]`).
///
/// Every bitmap on `Circle` is a `u8`, one bit per seat, so this bound is not
/// cosmetic: it is the width of `paid_bitmap` and its four siblings.
pub const MAX_MEMBERS: usize = 8;
/// SPEC §5 parameter ranges: `3 <= n <= 8`.
pub const MIN_MEMBERS: usize = 3;

#[account]
#[derive(InitSpace)]
pub struct Circle {
    pub creator: Pubkey,
    pub circle_id: u64,
    pub bump: u8,

    pub stock_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub price_feed: Pubkey,
    pub pool: Pubkey,

    /// 3..=8.
    pub n: u8,
    /// Index is the turn, 0-based. Unused seats are `Pubkey::default()`.
    pub members: [Pubkey; MAX_MEMBERS],

    /// USDC per member per round.
    pub contribution: u64,
    pub round_secs: i64,
    pub grace_secs: i64,
    /// e.g. 2000 = 20% off.
    pub haircut_bps: u16,
    pub coverage_bps: u16,
    pub warn_bps: u16,
    pub guarantee_per_member: u64,
    /// USDC, checked at join.
    pub min_stock_cover: u64,
    pub max_price_age: i64,

    pub status: CircleStatus,
    /// 0-based current round.
    pub round: u8,
    pub round_deadline: i64,

    /// Contributions received this round.
    pub paid_bitmap: u8,
    pub joined_bitmap: u8,
    pub withdrawn_bitmap: u8,
    pub received_bitmap: u8,
    pub defaulted_bitmap: u8,

    pub reserve_total: u64,
    pub reserve_losses: u64,
    pub reserve_allocated: u64,

    /// Replacement escrow (USDC).
    pub escrow: u64,
    /// Obligations not fundable at default time.
    pub escrow_deficit: u64,
    /// Cumulative paid out by withdraw.
    pub withdrawn_usdc: u64,
    /// Sum of guarantees and top-ups ever deposited.
    pub deposits_total: u64,
    /// Sum of `Member.forfeited`.
    pub forfeited_total: u64,
    /// Greater than zero means Paused (SPEC §5).
    pub next_gate_short_by: u64,
    /// This round's contributions, not yet released.
    pub held_contributions: u64,
    pub last_coverage_at: i64,
}

impl Circle {
    pub const SEED: &'static [u8] = b"circle";
}

/// SPEC §4. The only buyer of seized stock (ADR-004).
///
/// Declared here because `create_circle` must read `discount_bps` to enforce
/// `pool.discount_bps <= haircut_bps`. `init_pool` and `seed_pool` are T14.
#[account]
#[derive(InitSpace)]
pub struct LiquidationPool {
    pub authority: Pubkey,
    pub bump: u8,
    /// Conservative sale price = wrapper_price x (1 - discount).
    pub discount_bps: u16,
}

impl LiquidationPool {
    pub const SEED: &'static [u8] = b"pool";
}

/// One member's stake in one circle (SPEC §4, seeds `["member", circle, wallet]`).
///
/// The seat number is `turn`, and it is the index the creator fixed in
/// `Circle.members`, never a value the joiner supplies. `join_and_lock` finds it
/// by scanning, so a member cannot choose when they get paid.
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub circle: Pubkey,
    pub wallet: Pubkey,
    /// Index into `Circle.members`, 0-based. This is the payout order.
    pub turn: u8,
    pub bump: u8,

    /// Stock base units locked in the circle's vault. I4: the vault's balance
    /// is the sum of this across members.
    pub stock_raw: u64,
    /// The guarantee this member deposited at join, in usdc.
    pub guarantee: u64,
    /// Voluntary reserve top-ups, in usdc.
    pub top_ups: u64,
    /// Own guarantee and top-ups consumed by this member's own default (r2).
    pub forfeited: u64,

    /// Rounds this member has paid, including any prepaid from escrow.
    pub rounds_paid: u8,
    /// G_i at the last recompute. Zero once defaulted.
    pub allocated: u64,
    /// Saturating. `u32::MAX` when O_i is 0 or the member defaulted, which the
    /// UI renders as "Nothing owed" or "Prepaid" and never as a percentage.
    pub last_coverage_bps: u32,
}

impl Member {
    pub const SEED: &'static [u8] = b"member";
}
