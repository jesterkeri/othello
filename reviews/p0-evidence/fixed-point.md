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
10. repricing guard (below) → `multiplier_price_mismatch` (existing code), in every valuation action including `declare_default`.

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

The mint alone cannot close this: it keeps only the latest scheduled change, so an activation at T1
followed by a change scheduled for a future T2 hides T1. And a valuation instruction cannot both record a
change and refuse: **an error rolls back every write the instruction made** (Joshua's review,
2026-09-26), so "record `mult_changed_at` and refuse" in one instruction records nothing.

**Design for P1 (replaces the earlier Rule A / Rule B):**

- Per circle, stored: `epoch_multiplier: u64` (fixed 1e9) and `epoch_observed_at: i64`. Set at
  `create_circle` to the mint's effective multiplier and `now`.
- New instruction **`observe_oracle_epoch`**: permissionless, moves no money, **succeeds**. It reads the
  mint's effective multiplier at `now`; if it differs from `epoch_multiplier`, writes
  `epoch_multiplier = effective`, `epoch_observed_at = now` and emits an event; otherwise changes nothing.
  `epoch_observed_at` is the observation time, never earlier than the real activation, so the guard
  below is conservative.
- **Every valuation action** (join_and_lock, release_pot, update_coverage, quote_valuation, and
  **declare_default**) refuses with `multiplier_price_mismatch` while either holds:
  1. the mint's effective multiplier now ≠ `epoch_multiplier` (a change nobody has observed yet); or
  2. `publish_time < epoch_observed_at + 900` (the supplied Pyth price was published less than 15 min
     after the observed epoch).
- The app bundles `observe_oracle_epoch` ahead of an action when it sees condition 1, so the user's
  action then waits only on condition 2 (a Pyth price at least 15 minutes newer than the observation).
- **`declare_default` refuses during the window too** (Joshua's decision). "Use the lower multiplier"
  can underprice the stock and seize too much; waiting fails safe. SPEC §6's "liquidation proceeds during
  Repricing" is superseded for v2; ADR-013 records it.
- Cost: after a change, actions wait for a Pyth update published at least 15 minutes after someone
  observes it. With shard-0 alone that can take hours; with on-demand posting, 15 minutes.

## Parameters

`max_price_age` 43,200 s (12 h) while only shard-0 is read; `max_conf_bps` proposed 200 (MSFTx showed 83
bps on 2026-09-25, the others ≤ 5 bps: `cadence.jsonl` will give the real distribution before this is
fixed).
