VERDICT: changes required

Scope: evidence only at `edb58cd`; no production-code judgement and no source changes.
The target head was checked before review and was `edb58cd`. The separate spike
worktree was checked read-only at `889df82`. This was necessarily not a blind U1
round: the prompt supplied the claimed answers and attack ideas before the review.

## 1. Units — PARTLY

The NFLXx observation supports a narrow conclusion: on 2026-09-12,
`Crypto.NFLXX/USD` was consistent with a price per displayed/share unit, and was
inconsistent by about 10x with a price per raw token. The live re-run reproduced
the same Pyth account, feed ID, Full verification, `77.98365991` price and
`multiplierNow: 10`.

It does not establish the universal claim in `units.md:7-10,31-32` that all seven
`Crypto.*X/USD` feeds use that unit. `ops/p0/units-nflxx.ts:8,21-48` samples only
NFLXx. The seven feeds have separate Pyth IDs (`ops/p0/pyth.ts:13,52-59`), and
the other six multipliers near one make the secondary check expressly unable to
distinguish the hypotheses (`units.md:48-54`). P1 needs either feed-by-feed
evidence from Pyth/Backed or a deliberately restricted initial allowlist; it may
not promote one NFLXx sample to a property of seven independent oracle products.

The probe also applies `multiplierNow` fetched at the sampling time to the
historical 2026-09-12 candle (`ops/p0/units-nflxx.ts:29,40-41`). NFLXx was 10 in
the evidence and is likely unchanged, but the probe has not established that it
was 10 on the candle date. A later multiplier change would make the historical
per-share comparison wrong. Record the mint bytes/effective multiplier alongside
the candle date, or use an independently time-bound price source.

## 2. Crate — PARTLY

The compatibility result is good evidence: the spike pins SDK 2.0.0 with the
same Anchor 1.1.2 instance (`crate-spike.md:63-86`), and its bankrun test uses
real devnet bytes. The test actually demonstrates fresh read, non-canonical
address acceptance, stale rejection, wrong-feed rejection, wrong-owner rejection,
and Partial rejection (`crate-spike.md:88-115`; spike
`tests/p0-pyth-sdk-spike.spec.ts:38-83`). Accepting a valid account at any address
is compatible with option C; it is not a missing PDA check.

But the spike does not execute a wrong-discriminator case. Thus it proves the
owner refusal, and that a genuine discriminator deserializes, but not the claimed
runtime refusal for a bad discriminator/length. `Account<PriceUpdateV2>` should
provide that through Anchor and the SDK source was inspected, but P0's bankrun
evidence has not exercised it. Add malformed-discriminator and truncated/trailing
account cases before treating the account-validation assertion as tested rather
than sourced.

## 3. Liveness — PARTLY

The measured fact is supported. The one-shot independent devnet recheck found
all seven derived accounts receiver-owned, 134 bytes, `22f123639d7ef4cd`, Full,
and feed-matching, all still published at `2026-09-25T19:01:50Z`. That corroborates
the reported 41.4-hour age at the stated 2026-09-27 observation time. Hermes
metadata independently returned all seven expected IDs and the `O,O,O,O,O,O,O`
schedule.

The broader statement that free accounts “update only on weekdays” and therefore
will do so generally is not established by one 41.4-hour weekend interval.
`cadence.md:3-4,188-204` has one initial row per feed and one transient failure;
the logger records only changes/errors, no heartbeat (`ops/p0/cadence-logger.ts:31-61`),
so its JSONL cannot distinguish “continued polling and no update” from a process
that stopped after its last record. The asserted direct re-check is not preserved
as raw account data in the evidence. The conclusion that unmanaged shard-0 is not
an owned availability service is nevertheless well founded, and C's acceptance of
any valid account is the right program shape.

“On-demand posting is required before a user pilot” is conditional, not yet a
settled operational fact. It is required for a pilot that promises weekend/regular
availability, but P0 has not shown that a paid Hermes key supplies valid
`Crypto.*X/USD` updates over a weekend, nor measured posting latency, transaction
count/compute, update-account rent recovery, or failure behaviour. The document
correctly labels the key question open (`cadence.md:211-214`); do not label C
pilot-ready until that trial is measured.

## 4. Fixed point — PARTLY

The dimensional arithmetic in `fixed-point.md:243-258` is sound for a -8 Pyth
price, 8-decimal raw amount, 1e9 fixed multiplier, and USDC's 6 decimals. It
uses the lower price and end-of-expression floors for collateral, and ceiling for
the debt-driven seizure amount. The confidence inequality is correctly expressed
without division (`fixed-point.md:226-241`). Requiring exponent -8 avoids silent
rescaling. The existing code also already constrains haircut and pool discount to
less than 10,000 bps, but ADR-013 must retain those bounds.

It is not yet an exact safe specification. A positive accepted `p_low` can produce
`wrapper_low == 0`, and therefore `conservative == 0`; `ceil(O * 1e8 /
conservative)` then divides by zero (`fixed-point.md:246-252`). For example,
`p_low = 1` and `mult_fixed = 1_000_000_000` passes the listed price/confidence
checks but floors to zero at `wrapper_low`. This contradicts the stated
“overflow → math_overflow, never a panic” rule. Require `wrapper_low > 0` and
`conservative > 0` before the division, with a specified safe refusal (or an
explicit no-sale/paused outcome), and test both paths.

P1 / ADR-013 must also settle and test: checked conversion of positive `i64`
price to `u128`; checked `now - publish_time` and `epoch_observed_at + 900`;
parameter bounds for max confidence/age and all bps; the maximum supported raw,
multiplier and price magnitudes (the illustrative `1e14/1e11/1e12` bounds at
`fixed-point.md:258` are not enforced); a single shared valuation helper for all
five listed actions; and the exact behaviour when a current multiplier change is
observed between transactions. It must preserve the stated fail-closed
`declare_default` policy rather than the old SPEC repricing branch.

## Findings

1. **MAJOR — INSIDE.** The all-seven per-share decision overreaches one NFLXx
   sample. Files: `reviews/p0-evidence/units.md:7-10,31-32`,
   `ops/p0/units-nflxx.ts:8,21-48`. It could be wrong if another `Crypto.*X/USD`
   feed has a different unit convention; its near-1 multiplier would conceal it.
   Fix: bind each allowed mint/feed to evidence of its unit, or initially permit
   only feeds so evidenced.

2. **MAJOR — INSIDE.** “Weekdays only” is generalized from one partial weekend
   with no durable poll heartbeat. Files: `reviews/p0-evidence/cadence.md:3-4,188-204`,
   `reviews/p0-evidence/cadence.jsonl:1-8`,
   `ops/p0/cadence-logger.ts:31-61`. It could be wrong if the logger stopped or
   if the updater posts on a later weekend. Fix: emit heartbeats, retain raw RPC
   rechecks, and observe several full weekends; separately run the paid-key
   weekend test before pilot readiness.

3. **MAJOR — INSIDE.** The liquidation formula permits a zero divisor despite
   claiming checked, non-panicking arithmetic. File:
   `reviews/p0-evidence/fixed-point.md:226-258`. It could be wrong for any very
   small but positive Pyth price/confidence combination. Fix: add explicit
   nonzero checks and refusal semantics before division, plus boundary tests.

4. **MINOR — INSIDE.** SDK bankrun coverage does not mutate the discriminator or
   test a truncated account. Files: `reviews/p0-evidence/crate-spike.md:111-115`,
   spike `tests/p0-pyth-sdk-spike.spec.ts:38-83`. It could be wrong if an Anchor
   integration/version behaviour differs from the assumed Account validation.
   Fix: add those two bankrun refusals and pin their errors.

5. **MINOR — INSIDE.** The historical comparison uses a current multiplier.
   File: `ops/p0/units-nflxx.ts:29,40-41`. It could be wrong after a multiplier
   event between candle and sampling time. Fix: preserve/verify the multiplier
   effective on the candle date.

## U7

Findings: **5 INSIDE, 0 OUTSIDE**. This is a warning, not reassurance: this
prompt named the central unit, decoder, liveness and arithmetic risks in advance.
Per U1, the count is indicative only, not a blind-review measurement.

## U8 / U9

Not checked: no `anchor build`, deploy, transaction, or spike test was run; the
spike's recorded build/test output and fixture provenance were taken as evidence.
I did not access `.env*`, credentials, keystores, a Hermes key, or a Pyth plan
account; consequently I could not test signed-update retrieval/posting, weekend
publisher behaviour, update latency, costs, or rent closure. I did not directly
query GeckoTerminal; the repository chart route was inspected and its live public
response identifies `candles` as the selected array. I did not conduct an
unscoped audit of the current program/SPEC beyond consumers needed to evaluate
the proposed formulas. That is outside this evidence-review scope and there has
not been an unscoped sweep in this review.

## Verification run (real output)

```
$ git -C /home/hr/myvscode_linux/othello-pyth rev-parse --short HEAD
edb58cd
$ git -C /home/hr/myvscode_linux/othello-pyth-spike rev-parse --short HEAD
889df82
```

```
$ npx tsx ops/p0/units-nflxx.ts
{
  "sampledAt": "2026-09-27T12:28:30.392Z",
  "pyth": {
    "account": "FUqSvECa7qTFsn8QncA5MHpohUfz227295LFvVj5AWFh",
    "owner": "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    "verification": "Full",
    "feedId": "02a67e6184e6c9dd65e14745a2a80df8b2b3d2ca91b4b191404936003d9929ae",
    "price": 77.98365991,
    "conf": 0.53866,
    "exponent": -8,
    "publishTime": "2026-09-12T12:18:29.000Z"
  },
  "mint": {
    "address": "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
    "multiplierNow": 10
  },
  "jupiterNow": {
    "perDisplayedUnit": 71.45869609643309,
    "perRawToken_sell_1e8_raw": 697.128498
  },
  "geckoTerminalSameDay": {
    "day": "2026-09-12",
    "pool": "7RQXW5KEBgHCcy1eSNs1Kh7BWaEL46q8jb9t18S151bL",
    "perRawOpen": 773.3777985173658,
    "perRawClose": 760.3359813228496,
    "perShareOpen": 77.33777985173658,
    "perShareClose": 76.03359813228496
  },
  "ratios": {
    "pythOverJupiterPerUi": 1.0913109834072752,
    "pythOverJupiterPerRaw": 0.11186411132772253,
    "pythOverSameDayPerRawClose": 0.10256473693948072,
    "pythOverSameDayPerShareClose": 1.0256473693948072
  }
}
```

```
$ node --input-type=module -e '<seven-feed Hermes spot check>'
{"symbol":"AAPL","status":200,"id":"978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675","schedule":"America/New_York;O,O,O,O,O,O,O;","description":"APPLE XSTOCK / US DOLLAR"}
{"symbol":"AMZN","status":200,"id":"7148fbe6e493ff2580305c92a8d7f8628c9943b11b9b253aebc24863fec290e8","schedule":"America/New_York;O,O,O,O,O,O,O;","description":"AMAZON XSTOCK / US DOLLAR"}
{"symbol":"GOOGL","status":200,"id":"b911b0329028cd0283e4259c33809d62942bd2716a58084e5f31d64c00b5424e","schedule":"America/New_York;O,O,O,O,O,O,O;","description":"ALPHABET XSTOCK / US DOLLAR"}
{"symbol":"META","status":200,"id":"bf3e5871be3f80ab7a4d1f1fd039145179fb58569e159aee1ccd472868ea5900","schedule":"America/New_York;O,O,O,O,O,O,O;","description":"META XSTOCK / US DOLLAR"}
{"symbol":"MSFT","status":200,"id":"bb723a70af731ab56b9a650eb7e8ac22b7bc07ea77f8670bd1fa9a37bf6df3f5","schedule":"America/New_York;O,O,O,O,O,O,O;","description":"MICROSOFT XSTOCK / US DOLLAR"}
{"symbol":"NVDA","status":200,"id":"4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f","schedule":"America/New_York;O,O,O,O,O,O,O;","description":"NVIDIA XSTOCK / US DOLLAR"}
{"symbol":"TSLA","status":200,"id":"47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362","schedule":"America/New_York;O,O,O,O,O,O,O;","description":"TESLA XSTOCK / US DOLLAR"}
```

```
$ npx tsx -e '<one-shot devnet decode>'
{"symbol":"AAPLx","account":"Gs4DVtiGSJ9LJvXaQFjYp6vhLNK2QsH4qWox2ck1kuMp","owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","length":134,"disc":"22f123639d7ef4cd","verification":"Full","feedMatches":true,"price":341.36607888000003,"conf":0.11801331,"exponent":-8,"publish":"2026-09-25T19:01:50.000Z","postedSlot":"504129991"}
{"symbol":"AMZNx","account":"HVWLZ3JEY6nV1zKtAmdsNsUm99SrYs4b5MGVCJkeAZ66","owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","length":134,"disc":"22f123639d7ef4cd","verification":"Full","feedMatches":true,"price":249.5414507,"conf":0.06854930000000001,"exponent":-8,"publish":"2026-09-25T19:01:50.000Z","postedSlot":"504130004"}
{"symbol":"GOOGLx","account":"HeLrriTGigH3g9qgzZTpkWWkYe1yXKgE6nA7YdBjsvva","owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","length":134,"disc":"22f123639d7ef4cd","verification":"Full","feedMatches":true,"price":345.10050574,"conf":0.0953692,"exponent":-8,"publish":"2026-09-25T19:01:50.000Z","postedSlot":"504130020"}
{"symbol":"METAx","account":"HmqkFx31Jk1STgqVfxYAz6pKtwgn9mXZdNZfWnu6sqWS","owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","length":134,"disc":"22f123639d7ef4cd","verification":"Full","feedMatches":true,"price":754.56838757,"conf":0.18904338,"exponent":-8,"publish":"2026-09-25T19:01:50.000Z","postedSlot":"504130020"}
{"symbol":"MSFTx","account":"9KiECPa4BdbLHM61iur7u7svmRKA2MUJ76RLGfsVihvC","owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","length":134,"disc":"22f123639d7ef4cd","verification":"Full","feedMatches":true,"price":513.80182,"conf":4.2791310000000005,"exponent":-8,"publish":"2026-09-25T19:01:50.000Z","postedSlot":"504129991"}
{"symbol":"NVDAx","account":"6TPsjFigUaMFanRCsxQ4WbmG215xhRBXsb5y5Cn5L6eE","owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","length":134,"disc":"22f123639d7ef4cd","verification":"Full","feedMatches":true,"price":224.4762186,"conf":0.12121854,"exponent":-8,"publish":"2026-09-25T19:01:50.000Z","postedSlot":"504130004"}
{"symbol":"TSLAx","account":"GpoWLTd6GoisYxYgHz7mTcZvgnfJu4SN7T6PxWjgUTFY","owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","length":134,"disc":"22f123639d7ef4cd","verification":"Full","feedMatches":true,"price":372.09677081,"conf":0.07785415,"exponent":-8,"publish":"2026-09-25T19:01:50.000Z","postedSlot":"504130033"}
```
