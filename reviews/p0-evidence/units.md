# P0.1 Units: is Pyth's `Crypto.*X/USD` priced per displayed unit (share) or per raw token?

**Result (narrowed after P0 review r1):**
- **Proven for one feed:** `Crypto.NFLXX/USD` is priced **per displayed unit (per share)**.
- **Not proven for the seven devnet feeds** (AAPLX, AMZNX, GOOGLX, METAX, MSFTX, NVDAX, TSLAX): they are
  separate Pyth products. One NFLXx sample does not establish their convention.
- **Safe rule adopted for P1** (below): a feed whose unit is unproven may value collateral **only while its
  mint's effective multiplier is exactly 1**, where per-share and per-raw prices are identical. Today that
  admits **TSLAx and AMZNx** (multiplier exactly 1); the other five wait for per-feed evidence.

## NFLXx: the proof

NFLXx's Token-2022 multiplier is 10 since its 10-for-1 split, so its per-share and per-raw prices differ
tenfold: a natural experiment needing no statistics.

- `ops/p0/units-nflxx.ts` (read-only) → `units-nflxx.json` (re-run 2026-09-27T12:40:37Z).
- Pyth `Crypto.NFLXX/USD` (mainnet shard-0 `FUqSvECa7qTFsn8QncA5MHpohUfz227295LFvVj5AWFh`, owner receiver,
  Full, feed id matches, exp −8): **77.98365991**, published 2026-09-12T12:18:29Z.
- GeckoTerminal NFLXx/USDC (Raydium CLMM) daily candle 2026-09-12, **per raw token**: open 773.38, close 760.34.
- **Multiplier in force on 2026-09-12 = 10, time-bound (review r1 MINOR):** the mint's ScaledUiAmountConfig
  (Token-2022 extension type 25, bytes saved in `units-nflxx-mint.json`, mainnet slot 450,999,501) records its
  latest change as **1 → 10, effective 2025-11-16T23:55:00Z**. A mint keeps only its latest scheduled change,
  so any change after that date would carry a later timestamp; the multiplier on 2026-09-12 was therefore 10.
  The probe now computes `multiplierInForceOnCandleDay` from that record and refuses to compare otherwise.
- Ratios: Pyth / same-day per-share close = **1.026**; Pyth / same-day per-raw close = **0.103**. The per-raw
  reading is off by ~10×; the per-share reading is within 2.6% on the same day (that day's range 55.00 to 86.39
  per share). For NFLXx: per share.

## Why this does not extend to the seven feeds

Each `Crypto.*X/USD` is its own product with its own publishers. The seven's multipliers are within 0.6% of 1
(AAPLx 1.0033, MSFTx 1.0059, GOOGLx 1.0024, METAx 1.0029, NVDAx 1.0017; **TSLAx and AMZNx exactly 1**), so a
wrong unit convention would be hidden inside ordinary market noise.

## The rule for P1 (ADR-013)

The allowlist entry for each mint carries `unit: PerShare | Unproven`:
- `PerShare`: value = raw × effective multiplier × price (per share).
- `Unproven`: value only while the mint's effective multiplier is **exactly 1e9 (fixed)**; otherwise the
  valuation refuses (`price_unit_unproven`), the same as a stale price (contributions still allowed).
- A feed moves to `PerShare` only with evidence recorded in this folder: per-feed sampling (below), or Pyth's
  or the issuer's written statement for that feed.

This is safe regardless of the true convention: at multiplier exactly 1 both conventions give the same value.

## Per-feed evidence plan (for the five with multiplier ≠ 1)

- `ops/p0/cadence-logger.ts` (v2, `cadence-v2.jsonl`) records, on every devnet update, Pyth's price beside
  Jupiter's per-displayed-unit and per-raw prices for the real mint, plus the multiplier.
- Decision rule, fixed before looking: per feed, over at least 30 update samples taken within 60 s of a Pyth
  publish, compute the median of `pyth / jupiter_per_unit − 1` and of `pyth / jupiter_per_raw − 1`. Mark
  `PerShare` only if the per-unit median is within ±0.10% **and** the per-raw median is off by at least half the
  multiplier gap in the expected direction. MSFTx (gap 0.59%) and AAPLx (0.33%) are the most decidable; NVDAx
  (0.17%) may stay `Unproven`.
- Or: Joshua asks Pyth (Discord) for the unit convention of each `Crypto.*X/USD` feed and saves the answer here.
