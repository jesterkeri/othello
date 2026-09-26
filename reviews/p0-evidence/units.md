# P0.1 Units: is Pyth's `Crypto.*X/USD` per displayed unit or per raw token?

**Result: PASS, per displayed (scaled UI) unit, i.e. per share.**

## Method

The seven candidate xStocks have multipliers within 0.6% of 1 (AAPLx 1.00327, MSFTx 1.00590, ...), too
close to separate the two hypotheses against market noise and Pyth's publish lag. NFLXx has a real
multiplier of **10** (its 10-for-1 split, effective 2025-11-16T23:55Z), so its per-share and per-raw prices
differ tenfold: a natural experiment with no statistics needed.

`ops/p0/units-nflxx.ts` (read-only) reads Pyth's mainnet shard-0 `Crypto.NFLXX/USD` PriceUpdateV2 and
compares it with Jupiter now (per displayed unit; and a sale of exactly 100,000,000 raw base units =
1 whole raw token) and with GeckoTerminal's per-raw daily candle for the day Pyth last published.
Output: `units-nflxx.json` (sampled 2026-09-26T06:57:30Z).

## Evidence

| Source | Unit | Value |
|---|---|---|
| Pyth `Crypto.NFLXX/USD` (acct `FUqSvECa…AWFh`, owner receiver, Full, feed id matches, exp −8) | ? | **77.9837** ± 0.5387, published 2026-09-12T12:18:29Z |
| GeckoTerminal NFLXx/USDC Raydium CLMM, 2026-09-12 | per raw token | open 773.38, close 760.34 |
| same ÷ multiplier 10 | per share | open 77.34, close 76.03 |
| Jupiter now (2026-09-26) | per displayed unit | 71.27 |
| Jupiter now, sell 1e8 raw | per raw token | 696.04 |

Ratios: Pyth / same-day per-share close = **1.026**; Pyth / same-day per-raw close = **0.103**.
Against today's Jupiter: 1.094 (per unit) vs 0.112 (per raw); the 9% gap is two weeks of market
movement (Pyth's mainnet account is stale since 12 Sep).

The per-raw hypothesis is off by a factor of ~10; the per-unit hypothesis is within ~2.6% on the same
day (intraday range that day: 55.00 to 86.39 per share). Decided.

## Consequence for the formula (P0.4 / ADR-013)

The feed prices one **share** (one displayed unit). A position's value needs the mint's effective
multiplier:

`value_usdc = floor(raw × mult_fixed × p_low_usdc / (1e9 × 1e8))`

where `p_low_usdc` is the per-share low price in USDC 6-dp. This is today's FUND shape
(`valuation.rs:249`) with Pyth's per-share price in place of `share_price`. Because the formula multiplies
by the multiplier **now** and Pyth's price was **published earlier**, a multiplier activation between the
two would value the position at `new_mult × old_price`. That is exactly the window the repricing
guard (refuse while the latest activation is later than `publish_time − 15 min`) must close; for
NFLXx's split it would be a 10× over-valuation.

## Secondary check (running)

`ops/p0/cadence-logger.ts` records, on each devnet update of the seven, Pyth's price beside Jupiter's
per-unit and per-raw prices (`cadence.jsonl`). With multipliers ≤ 1.006 it cannot decide units on its
own; it is kept as a consistency check. No multiplier activation for the seven is scheduled in the
window (all `effectiveAt` are in the past), so an observed activation is not expected; the NFLXx ×10
result stands on its own.
