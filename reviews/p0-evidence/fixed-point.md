# P0.4 Fixed-point and checks, written exactly (input to ADR-013)

Units are settled (units.md): Pyth's `Crypto.*X/USD` prices **one share = one displayed unit**.

## Inputs (one PriceUpdateV2, any address)

`price: i64`, `conf: u64`, `exponent: i32`, `publish_time: i64`, `feed_id: [u8;32]`,
`verification_level`, account owner. Plus the mint's ScaledUiAmountConfig and `Clock::unix_timestamp`
(`now`).

## Refusals, in this order (each its own error)

1. owner ≠ Pyth receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, or wrong discriminator/length →
   Anchor's `Account<PriceUpdateV2>` rejects (P0.3 decides SDK vs complete decoder).
2. `verification_level ≠ Full` → `price_unverified`.
3. `feed_id ≠ ALLOWLIST[circle.stock_mint]` → `price_feed_mismatch`.
4. `exponent ≠ −8` → `price_exponent_unsupported` (all seven are −8, verified live).
5. `price ≤ 0` → `price_invalid`.
6. `conf ≥ price` (as u64) → `price_invalid`.
7. `publish_time > now` → `price_from_future`.
8. `now − publish_time > circle.max_price_age` → `price_stale` (existing code).
9. `conf × 10000 > max_conf_bps × price` (u128, no division) → `price_uncertain`.
10. repricing guard (below) → `multiplier_price_mismatch` (existing code), except in `declare_default`.

Steps 2, 3 and 8 are what the SDK's `get_price_no_older_than` checks together. If the SDK is used,
it is called first and the remaining checks follow.

## Arithmetic (checked u128 throughout; overflow → `math_overflow`, never a panic)

```
p_low  = price − conf                                  // feed units (1e-8 USD), exact, > 0 by step 6
value  = floor( raw × mult_fixed × p_low / (1e9 × 1e8 × 1e2) )     // USDC 6-dp; one floor, at the end
H      = floor( value × (10000 − haircut_bps) / 10000 )
wrapper_low = floor( p_low × mult_fixed / (1e9 × 1e2) )             // USDC 6-dp per whole raw token
conservative = floor( wrapper_low × (10000 − pool.discount_bps) / 10000 )   // SPEC §6 unchanged below
sell_raw  = min(stock_raw_d, ceil(O × 1e8 / conservative))
recovered = floor(sell_raw × conservative / 1e8)
```

`1e2` converts 1e-8 USD to USDC's 1e-6. `p_low` is taken before any rounding (Pyth's "collateral at μ−σ").
Flooring `wrapper_low` lowers the sale price, so the pool is never overpaid; I9 (seized value at the
conservative price ≤ O + one raw unit) keeps holding because `sell_raw` is computed from the same
floored price. Magnitudes: raw ≤ 1e14, mult_fixed ≤ 1e11, p_low ≤ 1e12 → product ≤ 1e37 < u128 max 3.4e38.
Larger inputs return `math_overflow`.

## Repricing guard (replaces ADR-005's `priced_for_multiplier` stamp)

The formula multiplies by the multiplier **now** and a price **published earlier**. An activation in
between values the position at `new_mult × old_price` (10× for NFLXx's split). xStocks' docs advise
pausing about 15 minutes before and after an activation (docs.xstocks.fi/developers/multipliers).

- Rule A: if the mint's `new_multiplier_effective_timestamp ≤ now` and it is later than
  `publish_time − 900`, refuse.
- **Gap in rule A (for P1 to close):** the mint keeps only the latest scheduled change. If a change
  activates at T1 and another is scheduled for a future T2 before anyone reads the circle, T1 is no
  longer visible. Proposed Rule B: the circle stores `mult_seen` and `mult_changed_at`; whenever the
  effective multiplier differs from `mult_seen`, record `mult_changed_at = now` (observation time, ≥ the
  real activation, so conservative) and refuse until `publish_time ≥ mult_changed_at + 900`. Cost: after
  an unobserved change the circle waits for the next Pyth update, which with shard-0 alone can take hours.
- `declare_default` stays usable under the guard, as today (SPEC §6: liquidation proceeds during
  Repricing). **Open for P1:** today it uses the non-scaled wrapper price, which the admin set; with Pyth
  the wrapper price is derived from the per-share feed × the multiplier now, so it is exposed to the same
  window. Options for ADR-013: refuse `declare_default` during the window too (a default waits ≤ one Pyth
  update), or price it with the lower of the old and new multiplier. To be decided in P1, with Codex.

## Parameters

`max_price_age` 43,200 s (12 h) while only shard-0 is read; `max_conf_bps` proposed 200 (MSFTx showed 83
bps on 2026-09-25, the others ≤ 5 bps: `cadence.jsonl` will give the real distribution before this is
fixed).
