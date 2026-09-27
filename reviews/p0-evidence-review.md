VERDICT: changes required

Scope: committed evidence at `6ea0c6c` only, plus read-only inspection of the
spike at `6f8efb6`. The target head was checked first and matched. The working
tree has three uncommitted logger rows in `reviews/p0-evidence/cadence-v2.jsonl`;
they were not treated as r2 evidence and were not changed. This is not a blind
U1 review: the prompt supplied both conclusions and attack themes before review.

## Round-1 finding disposition

| r1 finding | Status | r2 answer |
|---|---|---|
| MAJOR: one NFLXx sample was presented as all-seven unit evidence | RESOLVED | `units.md:3-9,29-44` explicitly confines proof to NFLXx, makes the seven feeds `Unproven`, and makes non-1e9 multipliers fail closed. |
| MAJOR: “weekdays only” came from one interval without durable polling evidence | RESOLVED | `cadence.md:3-9` now says exactly one observed weekend, not a general weekday rule; `ops/p0/cadence-logger.ts:41-49` emits 15-minute raw-byte heartbeats. It correctly leaves two further weekends as future measurement. |
| MAJOR: accepted positive price could produce a zero liquidation divisor | RESOLVED | `fixed-point.md:45-53` specifies `wrapper_low == 0 || conservative == 0` refusal before division, no transfer, and two boundary tests. |
| MINOR: discriminator/truncation behaviour was asserted, not bankrun-tested | RESOLVED | spike `tests/p0-pyth-sdk-spike.spec.ts:89-113` tests both receiver-owned malformed cases and records trailing-byte acceptance; `crate-spike.md:52-56` reports the result. |
| MINOR: the candle used today’s multiplier without time binding | PARTLY | r2 preserves current mint bytes (`units-nflxx-mint.json`) and `units-nflxx.ts:29-33` rejects an effective date after the candle. But the probe still gets the parsed fields from the mutable Vercel `/api/live` response rather than decoding the saved mint bytes, and a current mint record is not historical evidence of every intervening multiplier update. |

## 1. Units — PARTLY SUPPORTED

The same-day NFLXx comparison supports a narrow, plausible inference: if the
multiplier was 10 on 2026-09-12, Pyth 77.98 is compatible with the per-share
close 76.03 and incompatible with the per-raw close 760.34. The public Hermes
metadata spot check still maps the recorded feed ID to `Crypto.NFLXX/USD`, and
the public RPC spot check confirms the recorded Pyth account is receiver-owned
and 134 bytes.

The evidence does not yet make the multiplier-at-candle fact independently
reproducible. `units.md:20-24` interprets a current extension snapshot as a
history, but the saved raw bytes are not decoded by the probe; `units-nflxx.ts:24-33`
instead trusts an application endpoint. Obtain and retain the mint-update
transaction/history (or a dated mint-account snapshot), decode the saved bytes
locally, and state the Token-2022 update semantics relied on. Until then, NFLXx
should remain a strong inference rather than an irrevocable `PerShare` entry.

The fail-closed `Unproven`/exact-1e9 rule at `units.md:35-44` is safe. However,
the proposed 30-sample Jupiter test at `units.md:48-54` is not, by itself, a
proof of unit convention: a Pyth publisher/reference price and an executable
Jupiter sell quote can have a persistent venue or methodology basis. That basis
can make the wrong unit appear closer over every sample. A Pyth/issuer statement
or a pre-specified independent reference whose unit is established is required
before promotion to `PerShare`.

## 2. Crate — SUPPORTED

The spike pins `pyth-solana-receiver-sdk =2.0.0` alongside Anchor 1.1.2 and the
committed source calls `Account<PriceUpdateV2>::get_price_no_older_than`
(`programs/othello/src/pyth_spike.rs:7-16` on `6f8efb6`). Its nine bankrun cases
use real devnet bytes and cover valid noncanonical addresses, age, feed ID,
owner, Full verification, discriminator, truncation, and trailing bytes
(`tests/p0-pyth-sdk-spike.spec.ts:41-113`). That supports SDK selection and the
claim that owner/discriminator validation is exercised; it does not claim that
the still-unwritten valuation path has been tested.

## 3. Liveness — PARTLY SUPPORTED

The evidence supports one 41.4-hour weekend stale interval and supports the
operational conclusion that an unknown third-party updater is not Othello’s
availability guarantee (`cadence.md:3-9,13-29`). The decision to accept any
valid, allowlisted, fresh `PriceUpdateV2` is compatible with the SDK spike and
does not require a canonical PDA.

It does not support pilot readiness or an on-demand availability promise.
`liveness.md:47-60` correctly says C behaves as B without a key and leaves paid
Hermes weekend publishing, latency, transaction/compute count, rent closure and
failure handling unmeasured. The only committed v2 heartbeat is an initial
heartbeat plus the initial observations (`cadence-v2.jsonl:1-8`); it proves the
format, not continuous operation. P1 must retain the 12-hour fail-closed ceiling
and the user-visible pause state until the trial supplies those measurements.

## 4. Fixed-point — NOT SUPPORTED

The lower-confidence-price calculation, end-of-expression collateral floor,
cross-multiplied confidence test, -8 exponent refusal, and r2 zero-divisor
rule are directionally correct (`fixed-point.md:11-58`). They are not yet an
exact safe P1 specification because the multiplier epoch mechanism can combine
a price from one multiplier epoch with another epoch’s multiplier, and because
the document never defines how the obligation `O` is formed and rounded up.

P1 / ADR-013 and the SPEC delta must therefore decide and test: the source and
rounding of every component of `O` (sum in USDC base units, with any conversion
or prorating rounded up); integer type/checked bounds for it and for every
intermediate; parameter bounds before subtraction; the exact `Unproven` feed
gate; and a multiplier-history or trusted-observer scheme that cannot miss an
activation/reversal. It must also reconcile the older blanket per-share claims
in `PRODUCT-DESIGN.md:140,391` with P0’s per-feed `Unproven` status before that
design is handed into implementation.

## Findings

1. **BLOCKER — INSIDE.** The proposed epoch guard misses a multiplier change and
   reversal between valuation calls. `fixed-point.md:85-98` changes state only
   when the multiplier at `observe_oracle_epoch` differs from the stored value.
   Concrete failure: epoch multiplier A is stored; the issuer changes A→B,
   Pyth publishes price B, then the issuer changes B→A before the next valuation.
   The current multiplier equals stored A, so condition 1 is false and no epoch
   timestamp is written; the still-fresh B-era price can be multiplied by A.
   The document itself recognises that the mint does not retain enough history
   at `fixed-point.md:78-81`, but the proposed solution does not cover the
   missed-observation case. P1 needs an authoritative change history/event
   source, an always-available observer whose updates are required before
   valuation, or a collateral policy that refuses mutable multipliers; merely
   asking the app to observe a visible difference is insufficient.

2. **MAJOR — INSIDE.** The fixed-point document reintroduces the all-feeds
   unit assertion that r2 otherwise withdrew. `fixed-point.md:3` says
   `Crypto.*X/USD` prices one displayed share and its formula at `:30-37` is
   unconditional, while `units.md:3-9,35-44` says all seven target feeds are
   unproven and only an exact 1e9 multiplier is safe. It could be wrong if P1
   implements the former for AAPLx/NVDAx/etc. before unit proof. Make the
   formula explicitly conditional on `PerShare`, put `price_unit_unproven`
   in the ordered refusal list, and synchronize the PRODUCT-DESIGN/SPEC delta.

3. **MAJOR — INSIDE.** `O`, the amount the liquidation must cover, has no
   definition or rounding contract. `fixed-point.md:36-37` uses it as an
   already-safe integer, although the stated system has unpaid principal and
   premiums and the required policy is obligations rounded up. It could be
   wrong if an implementation derives `O` through a floor or omits a scheduled
   premium, resulting in under-seizure while every displayed formula passes.
   Define `O` from named ledger fields in USDC base units, specify each rounding
   direction and cap, and add adversarial cases where a one-base-unit upward
   obligation changes `sell_raw`.

4. **MAJOR — INSIDE.** NFLXx’s historical multiplier claim remains dependent on
   an unverified current application response. `units.md:20-24` calls the claim
   time-bound, but `ops/p0/units-nflxx.ts:24-33` does not parse
   `units-nflxx-mint.json` and preserves no historical account/transaction
   proof. It could be wrong if the extension was updated after the candle (or
   if the route decoded it incorrectly), in which case the apparent 10x result
   does not identify the Pyth unit. Decode the committed bytes in the probe and
   retain a dated account history or mint-update transaction evidence that
   establishes the effective multiplier on the candle date.

5. **MINOR — INSIDE.** The 200-bps confidence proposal is based on a very thin
   distribution. `fixed-point.md:107-109` cites `cadence.jsonl`, but the
   committed file has seven initial feed rows from one published timestamp and
   one error, while `cadence-v2.jsonl` repeats that same stale timestamp. It
   could be wrong under normal active-market volatility. Keep 200 explicitly
   provisional and select the cap only from a measured fresh-update distribution,
   including weekend/on-demand observations.

## U7

Findings: **5 INSIDE, 0 OUTSIDE**. This is indicative, not rigorous, under U1:
the supplied prompt concentrated attention on all four evidence questions.
The all-inside count is a warning about framing, not evidence of a complete
review.

## U8 / U9

Not checked: no `anchor build`, deploy, transaction, Hermes authenticated
request, credential, `.env*`, keystore, or production code path was run. The
spike’s committed build and bankrun output were inspected rather than rerun, as
required. I did not verify paid-plan terms, signed-update retrieval, weekend
Hermes publishing, posting compute/rent recovery, or the claimed source of the
historical candle beyond the route/source inspection. Public RPC/Hermes/Jupiter
reads were spot-checked; they do not reconstruct historic state. I did not do
an unscoped audit of the program or design repository. The uncommitted logger
rows noted at the top were deliberately excluded from this frozen-commit review.

## Verification run (real output)

```
$ git -C /home/hr/myvscode_linux/othello-pyth rev-parse --short HEAD
6ea0c6c
$ git -C /home/hr/myvscode_linux/othello-pyth-spike rev-parse --short HEAD
6f8efb6
```

```
$ git diff --check 554173b..6ea0c6c
(no output; exit 0)
```

```
$ node <read-only mainnet RPC, Hermes metadata, and Jupiter checks>
{
  "http": 200,
  "slot": 451006066,
  "accounts": [
    {"owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","lamports":1659246,"dataLength":134},
    {"owner":"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb","lamports":5623680,"dataLength":680}
  ]
}
{
  "http": 200,
  "matches": [{
    "id":"02a67e6184e6c9dd65e14745a2a80df8b2b3d2ca91b4b191404936003d9929ae",
    "attributes":{"description":"NETFLIX INC XSTOCK / US DOLLAR","schedule":"America/New_York;O,O,O,O,O,O,O;","symbol":"Crypto.NFLXX/USD"}
  }]
}
{"price":70.76509522873218,"outAmount":"697002267","routePlanLength":1}
```
