VERDICT: implementation-ready

## r2 finding disposition

| r2 finding | Status | r3 answer |
|---|---|---|
| BLOCKER: A -> B -> A between observations could pair A with a B-era price | RESOLVED | `fixed-point.md:90-105` adds Rule P (refuse any pending change) and Rule L (require `publish_time >= latest_effective_at + 900`). The constructed reversal is rejected by Rule L; a still-pending reversal is rejected by Rule P. |
| MAJOR: all feeds were implicitly per-share | RESOLVED | `units.md:3-9,43-52` limits proof to NFLXx and makes unproven feeds fail closed unless their effective multiplier is exactly 1e9. `fixed-point.md:3-5,25` makes that gate part of the valuation contract. |
| MAJOR: `O` was undefined and could silently round down | RESOLVED | `fixed-point.md:134-148` defines named USDC-base-unit inputs, checked creation bounds, and upward rounding for any future prorating. |
| MAJOR: the candle-date multiplier was derived from a mutable application response | RESOLVED | `ops/p0/units-nflxx.ts:46-51` decodes both retained mint snapshots locally; `units-nflxx.json:16-38` records the two matching results. |
| MINOR: 200 bps was presented from a thin distribution | RESOLVED | `fixed-point.md:129-132` labels 200 provisional and requires fresh, weekend, and on-demand measurements before a pilot choice. |
| r1 item r2 left PARTLY: time-bound NFLXx multiplier | RESOLVED | The same two saved bytes at `units-nflxx-mint.json` and `tests/fixtures/NFLXx.json`, decoded by the probe, contain 1 -> 10 at 2025-11-16. The 2026-09-21 snapshot brackets the 2026-09-12 candle, subject to the now-explicit no-backdating issuer boundary (`units.md:20-30`). |

Scope: committed P0 evidence at `ca3c571`, with the spike worktree read only at
`6f8efb6`. `git rev-parse --short HEAD` was checked first and returned
`ca3c571`. This is a U1 single-prompt review, not a blind review: the prompt
supplied the prior findings and attack themes. U7 is consequently indicative,
not a measurement of independent discovery.

During this review, a running logger appended an uncommitted later row to
`reviews/p0-evidence/cadence-v2.jsonl`. It was neither edited nor treated as
r3 evidence; the committed file ends at its line 11.

## 1. Units — SUPPORTED, for the deliberately narrow conclusion

The evidence supports `Crypto.NFLXX/USD` being per displayed share, not per raw
token. The retained output binds a Full receiver-owned Pyth account and feed ID
to 77.98365991 at 2026-09-12T12:18:29Z, a raw-token candle close of
760.3359813, and a 10 multiplier at the candle date
(`units-nflxx.json:3-11,16-56`). The resulting 1.026 per-share ratio versus
0.103 per-raw ratio is sufficiently separated that daily-candle timing does
not plausibly explain the factor of ten.

This does not establish the seven other products. That limitation is correctly
preserved by the `PerShare | Unproven` allowlist policy (`units.md:35-52`). The
two local snapshot decodes independently returned the same multiplier,
timestamp and new multiplier. The conclusion still trusts the multiplier
authority not to backdate an update; Token-2022 explicitly permits a timestamp
before current time to take effect immediately, so this is a real trust boundary,
not a merely theoretical caveat.

## 2. Crate — SUPPORTED

The spike at `6f8efb6` pins receiver SDK 2.0.0 with Anchor 1.1.2 and records a
real-devnet-byte bankrun exercise. Its test source covers a valid account at a
noncanonical address, stale age, wrong feed, wrong owner, Partial verification,
wrong discriminator, truncation, and trailing data
(`tests/p0-pyth-sdk-spike.spec.ts:41-113`); the evidence correctly does not
claim this is a test of the future valuation path. The SDK conclusion is thus
supported. The recorded “9 passing” extension is accepted from the committed
test source and documentation; it was not rerun, per scope.

## 3. Liveness — PARTLY SUPPORTED

The evidence supports the decision-relevant conclusion: shard-0 is an unmanaged
third-party availability source, not an Othello guarantee. It supports one
observed 41.4-hour stale interval, not a general weekday-only rule
(`cadence.md:3-9,16-29`). Option C is accurately described as behaving as B
until an authenticated Hermes path exists, and as not pilot-ready until the
weekend publishing, latency, transaction/compute, rent recovery, and failure
measurements occur (`liveness.md:45-63`; `cadence.md:36-43`).

The continuous-measurement claim is weaker than stated: see Finding 1. This
does not undo the present decision to fail closed at 12 hours, but it means the
promised two further weekends cannot be treated as evidence unless logging is
made independently observable through failures and hangs.

## 4. Fixed point — SUPPORTED for P1 design, with stated P1 prerequisites

The calculations have the right dimensions and conservative directions. With
`raw` in 1e-8 token units, `mult_fixed` in 1e9, and Pyth price in 1e-8 USD,
the denominator in `fixed-point.md:34-40` is 1e19, producing USDC base units.
`p_low` is taken before rounding; collateral and recovery floor; `sell_raw`
ceilings; and the zero divisor is refused before division (`:43-56`). The
specified magnitude bounds keep each listed u128 product below its limit
(`:58-61`). The cross-multiplied confidence test avoids division and has a
positive-price precondition (`:20-24`).

### Multiplier attack

I could not construct a price/multiplier-epoch mix that passes both new rules
without a backdated issuer timestamp. For example:

1. A -> B activates at T1; Pyth publishes a B-era price at T1 + 60.
2. B -> A activates at T2 > T1 + 60 before the next valuation.
3. At T2, Rule L requires `publish_time >= T2 + 900`, so the B-era price fails.
   If B -> A is instead scheduled for T2 in the future, Rule P rejects every
   valuation until T2.

More updates do not reopen this path: while the final update is pending, Rule
P rejects; once it is effective, a price sufficiently after its timestamp is
also after every earlier, non-backdated activation. For the temporal-mixing
property, the stated issuer trust boundary is therefore the only remaining
gap, conditional on the usual Pyth authenticity/`publish_time` and Solana Clock
trust roots. It is not the only remaining P0 or pilot gap: unit promotion,
liveness trial results, and the P1 implementation/tests remain separate.

P1 must make the Rule-L addition checked (Finding 2), bind `unit` and feed ID
in the allowlist, use one helper on all five named valuation actions, and write
the adversarial cases in `fixed-point.md:63-73,145-148` before program code.

## Findings

1. **MAJOR — INSIDE.** `cadence.md:6-9` says the logger writes a raw-byte
   heartbeat every 15 minutes and therefore makes a stopped logger visible.
   The committed data contradicts the interval: its first heartbeat is at
   12:39:11, followed by errors at 13:02:17 and 13:03:24, and the next heartbeat
   only at 13:04:20 (`cadence-v2.jsonl:1,9-11`), over 25 minutes later.
   `ops/p0/cadence-logger.ts:32-73` awaits RPC, `/api/live`, and Jupiter fetches
   serially with no timeout; a hanging fetch produces neither an error row nor
   a heartbeat. Thus an apparent quiet period could be a dead measurement
   process rather than no updates. Before recording the next weekends, add
   bounded requests and a heartbeat independent of optional pricing calls (or
   downgrade the claim to best effort), then preserve the complete raw log.
   This does not change the existing 41.4-hour account-age observation or block
   P1 design; it blocks treating future gaps as continuous-monitor evidence.

2. **MINOR — INSIDE.** Rule L specifies
   `new_multiplier_effective_timestamp + 900` but `fixed-point.md:65-68` calls
   out checked addition only for `epoch_observed_at + 900`. A mint authority can
   choose the effective timestamp, and Token-2022 accepts a caller-supplied
   signed timestamp (`spl-token-2022-interface-2.1.0/.../instruction.rs:49-51`).
   Near `i64::MAX`, unchecked addition can overflow/panic or wrap, converting a
   fail-closed guard into an implementation-dependent result. Require checked
   addition for Rule L too, with overflow returning `multiplier_price_mismatch`.

3. **MINOR — INSIDE.** `ops/p0/units-nflxx.ts:50-51` calls snapshots
   “consistent” merely when each independently predates the candle and is
   fetched afterwards; it does not assert that their multiplier, effective
   timestamp, and new multiplier are equal before selecting snapshot zero. A
   disagreement can therefore still print a confident candle multiplier. The
   committed snapshots happen to agree, but a rerun or replacement fixture
   could hide the contradiction. Compare all three decoded fields (and reject
   duplicates/malformed TLV) before emitting `multiplierInForceOnCandleDay`.

4. **MAJOR — OUTSIDE.** The product design still states blanket “Pyth
   PriceUpdateV2, per share” at
   `/home/hr/myvscode_linux/othello-design/PRODUCT-DESIGN.md:391`, while P0
   permits `PerShare` only for NFLXx and makes all other feeds `Unproven`
   (`units.md:3-9,43-50`). If P1 copied the product-design sentence, it would
   reinstate precisely the all-feeds misvaluation P0 removed. The P0 hand-off
   identifies this at `fixed-point.md:150-154`; the P1 ADR-013/SPEC delta must
   resolve it before implementation. It is outside this frozen evidence folder
   and does not prevent starting that design work.

## U7

Findings: **3 INSIDE, 1 OUTSIDE**. The count is indicative only under U1; the
prompt named the principal evidence areas, and this was not a two-stage cold
review. The outside design contradiction is the reason the count should not be
read as a clean scope boundary.

## U8 / U9

Not checked: no Anchor build, deploy, transaction, authenticated Hermes
request, credentials, `.env*`, keystore, or production valuation path was run.
The spike’s recorded bankrun output was inspected, not rerun. I did not verify
paid Hermes terms, live weekend publishing, post/update/close transaction
sequence, compute, rent recovery, or Pyth publisher methodology. Public
mainnet/devnet RPC, Hermes metadata, and Jupiter were read only; they cannot
reconstruct historic mint state. U9: no unscoped audit of either repository was
performed; this is the requested evidence-folder review plus the specified
product-design and spike context.

## Verification run (real output)

```
$ git -C /home/hr/myvscode_linux/othello-pyth rev-parse --short HEAD
ca3c571
$ git -C /home/hr/myvscode_linux/othello-pyth-spike rev-parse --short HEAD
6f8efb6
```

```
$ node <read-only saved-mint decode>
[
  {"path":"tests/fixtures/NFLXx.json","slot":449145146,"fetchedAt":"2026-09-21T19:09:29.860Z","multiplier":1,"effectiveAt":"1763337300","newMultiplier":10},
  {"path":"reviews/p0-evidence/units-nflxx-mint.json","slot":450999501,"fetchedAt":"2026-09-27T12:39:34.886Z","multiplier":1,"effectiveAt":"1763337300","newMultiplier":10}
]
```

```
$ node <read-only mainnet/devnet RPC, Hermes metadata, Jupiter checks>
{"url":"https://api.mainnet-beta.solana.com","http":200,"slot":451009366,"owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","dataLength":134}
{"url":"https://api.devnet.solana.com","http":200,"slot":504796027,"owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","dataLength":134}
{"hermesHttp":200,"matches":[{"id":"02a67e6184e6c9dd65e14745a2a80df8b2b3d2ca91b4b191404936003d9929ae","symbol":"Crypto.NFLXX/USD"}]}
{"jupiterHttp":200,"price":70.76509522873218}
```

```
$ git diff --check 6ea0c6c..ca3c571
(no output; exit 0)
```
