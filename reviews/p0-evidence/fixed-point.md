# P0.4 Fixed-point and checks, written exactly (input to ADR-013)

Units (units.md): proven **per share for NFLXx only**; every other feed is `Unproven` until a written statement.
The per-share formula below applies only to a `PerShare` feed; an `Unproven` feed values collateral only while its
mint's effective multiplier is exactly 1e9 (review r2 MAJOR 2).

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
10. `unit == Unproven` and effective multiplier ≠ 1e9 → `price_unit_unproven`.
11. repricing guard (below) → `multiplier_price_mismatch` (existing code), in every valuation action including `declare_default`.

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
floored price.

**Zero-divisor rule (P0 review r1, MAJOR).** A positive, accepted `p_low` can still floor to
`wrapper_low == 0` (e.g. `p_low = 1`, `mult_fixed = 1e9`), and then `conservative == 0`, making
`ceil(O × 1e8 / conservative)` a division by zero. So, before any division:
- `wrapper_low == 0` or `conservative == 0` → **refuse with `price_too_low`** (a no-sale outcome: nothing is
  seized or paid; `declare_default` waits exactly as for a stale price, and the stress test reports it).
- The same guard applies to every divisor in the valuation helper; there is no path that divides by a price- or
  multiplier-derived zero.
- Tests: `p_low = 1` at `mult_fixed = 1e9` (wrapper floors to 0) and a discount that floors a tiny positive
  wrapper to 0, both refused with no transfer.

**Magnitude bounds, enforced (not illustrative).** P1 fixes and the program checks, refusing with
`math_overflow` / `invalid_params` beyond them: `raw ≤ 1e14` (1e6 whole tokens at 8 decimals),
`mult_fixed ≤ 1e11` (multiplier ≤ 100), `price ≤ 1e12` (≤ $10,000 per share at exponent −8). Product
≤ 1e37 < u128 max 3.4e38.

## What P1 (ADR-013) must also settle and test (P0 review r1)

- Checked conversion of a positive `i64` price and `u64` conf to `u128`; negative or zero price refused first.
- Checked `now − publish_time` (future `publish_time` refused) and checked `epoch_observed_at + 900`.
- Parameter bounds: `max_price_age`, `max_conf_bps`, `haircut_bps`, `pool.discount_bps` (each < 10,000 where a
  bps, and `discount_bps ≤ haircut_bps` as today).
- **One shared valuation helper** used by all five price-gated actions (join_and_lock, release_pot,
  update_coverage, quote_valuation, declare_default); no duplicated arithmetic.
- The per-feed unit rule (units.md): `Unproven` feeds value only at multiplier exactly 1e9.
- Exact behaviour when a multiplier change is observed between two transactions (`observe_oracle_epoch`), and
  `declare_default` refusing during the epoch window (fail closed), not the old SPEC repricing branch.

## Repricing guard (replaces ADR-005's `priced_for_multiplier` stamp)

The formula multiplies by the multiplier **now** and a price **published earlier**. An activation in
between values the position at `new_mult × old_price` (10× for NFLXx's split). xStocks' docs advise
pausing about 15 minutes before and after an activation (docs.xstocks.fi/developers/multipliers).

The mint alone cannot close this: it keeps only the latest scheduled change, so an activation at T1
followed by a change scheduled for a future T2 hides T1. And a valuation instruction cannot both record a
change and refuse: **an error rolls back every write the instruction made** (Joshua's review,
2026-09-26), so "record `mult_changed_at` and refuse" in one instruction records nothing.

**Design for P1 (review r2 BLOCKER: a change and its reversal between two observations must not slip through):**

Two mint-record rules, checked in every valuation, plus the observed epoch as a second layer:

- **Rule P (pending change): refuse while `new_multiplier_effective_timestamp > now`.** The mint remembers only
  its latest update, so while a change is scheduled any earlier activation may be hidden. Refusing for the whole
  pending window closes that gap. For TSLAx and AMZNx (no dividends) a pending change means a corporate action,
  so the cost is rare, announced pauses; `Unproven` feeds at multiplier ≠ 1e9 are refused anyway.
- **Rule L (latest change): if `new_multiplier_effective_timestamp ≤ now`, refuse unless
  `publish_time ≥ new_multiplier_effective_timestamp + 900`.** A reversal A→B→A is itself the latest change, so a
  B-era price, published before the reversal, is refused. Any earlier change precedes the latest one, so a price
  published 15 minutes after the latest change postdates all of them.
- **Why the pair is complete:** at any moment either a change is pending (Rule P refuses) or the latest change is
  in the past and bounds every earlier one (Rule L). Codex's case: A stored; A→B; Pyth publishes a B price; B→A
  before the next valuation. The B→A update sets the record's timestamp to its activation, later than the B
  price's `publish_time`, so Rule L refuses; had the reversal been scheduled for later, Rule P refuses until then.
- **Trust boundary:** both rules rely on the issuer not backdating `new_multiplier_effective_timestamp`. An issuer
  able to do that can already freeze or seize collateral (issuer powers, shown per stock), so Othello trusts the
  issuer here, stated in ADR-013 and the stock page, rather than claiming to defend against it.
- The observed epoch below stays as defence in depth (it also records the change for the app and events).

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

`max_price_age` 43,200 s (12 h) while only shard-0 is read, fail closed, with the user-visible pause state kept
until the Hermes trial measures otherwise. `max_conf_bps` **provisionally** 200 (review r2 MINOR): the logged
distribution is one stale timestamp (MSFTx 83 bps, others ≤ 5 bps), too thin to set a cap; the value is chosen
only from measured fresh updates, including weekend and on-demand observations, before any user pilot.

## The obligation `O` (review r2 MAJOR 3)

`O` is the amount a default must cover, in **USDC base units (u64, checked u128 arithmetic)**, formed only from
named ledger fields, never through a price:
- `O = unpaid_principal + unpaid_premium`
- `unpaid_principal = contribution × (n − rounds_paid_d)`: an exact integer product (SPEC §6 today), checked.
- `unpaid_premium = Σ scheduled premium instalments not yet collected` for that seat (saver-reward circles only;
  0 in mutual-aid circles, which is all the Colosseum pilot uses), each instalment an exact integer fixed at
  creation.
- No term is ever derived by division or prorating; if a future term needs prorating, it is rounded **up**
  (obligations up, collateral down).
- Bounds: `O ≤ n × contribution + Σ premiums ≤ u64::MAX`, checked at `create_circle`.
- Liquidation then uses `sell_raw = min(stock_raw_d, ceil(O × 1e8 / conservative))` with the zero-divisor rule.
- Adversarial tests for P2: a one-base-unit increase in `O` that raises `sell_raw` by one raw unit; `O` with an
  unpaid premium vs without; `O` at its bound.

## Hand-off note for P1

`PRODUCT-DESIGN.md` §6.1 (lines ~140 and ~391, reviewed at r11) still states per-share valuation for Solana
xStocks without the per-feed `Unproven` rule; the P1 SPEC delta must amend it with this document's rule before
anything is implemented.
