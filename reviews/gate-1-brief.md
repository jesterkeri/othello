# Gate 1 review brief: the valuation spike

Commit under review: `b7c68df4ff11c823c939aaf4f73a49c238255539`

That SHA is the contract. Any commit landing after it makes this review stale
and the gate is not passed until the new head has been reviewed.

The one exception is the commit that adds this brief, which changes no code.
Verify rather than take it:

```
git diff --stat b7c68df..HEAD -- programs ops tests scripts .github
```

That must be empty. If it is not, this brief is already stale.

**Gate 1 is offered as LOCALLY implementation-ready, NOT deploy-ready.** A
passing verdict here does not clear the deployment block in section 7. Nothing
has been deployed to any cluster.

Apply `orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9, in full.

---

## 1. What gate 1 had to prove

`SPEC.md` §10, G1. That an Anchor program can value Token-2022
`ScaledUiAmountConfig` collateral correctly across a corporate action. If it
cannot, nothing after it matters.

## 2. What exists

Program, `programs/othello/src`, 1402 lines including tests:

| file | contents |
|---|---|
| `valuation.rs` | the exact PodF64 decoder, the Token-2022 reader, FUND/EXEC/H, `value_position` |
| `allowlist.rs` | the four allowed mint addresses (ADR-012) |
| `state.rs` | `PriceFeed`, `PriceStamp` |
| `errors.rs` | seven refusal codes, append-only |
| `instructions/price_feed.rs` | `init_price_feed`, `set_prices`, `touch_prices` |
| `instructions/quote.rs` | `quote_valuation` |

Instruction surface: `init_price_feed`, `set_prices`, `touch_prices`,
`quote_valuation`. Accounts: `PriceFeed`. Errors 6000 `MultiplierInvalid`,
6001 `Unauthorized`, 6002 `InvalidParams`, 6003 `MultiplierPriceMismatch`,
6004 `PriceStale`, 6005 `ValuationOverflow`, 6006 `MintNotAllowed`.

The rest of `SPEC.md` §5 is gate 2 and gate 3 and is not written.

## 3. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
pnpm install
anchor build
anchor test          # 22 Rust, 31 mocha, 26 T00 cases
pnpm run test:p1     # the harness proof and its regression test
cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

`pnpm run test:t00` reaches nothing. It is the hostile-endpoint stub suite: it
serves both JSON-RPC and the issuer's product pages from a localhost server and
runs the fetcher against it with `OTHELLO_INSECURE_TEST_RPC=1`. The live command
is `pnpm run fetch-fixtures` (`ops/fetch-fixtures.ts`), which reaches
`api.mainnet-beta.solana.com` and `assets.backed.fi` AND REWRITES
`tests/fixtures/`. Do not run it if you want the committed fixtures left alone.

## 4. What to review

Everything in section 2, and `DONE.md` entries T00, T01, P1, T02 to T06 and R1,
which carry the real output and the decisions.

The claims this gate rests on, each to be checked rather than accepted:

1. `decode_multiplier_fixed` returns `floor(multiplier × 1e9)` exactly, for
   every input it accepts, and refuses NaN, both infinities, negatives
   including `-0.0`, anything that scales past u64, and anything that floors to
   zero.
2. The multiplier the program uses is the one the Clock selects, with an
   inclusive boundary at `new_multiplier_effective_timestamp`.
3. Token-2022's `StateWithExtensions` and the test-only TLV byte reader agree,
   field for field, on all four committed mainnet fixtures.
4. `set_prices` cannot bind a price to a multiplier the caller did not name,
   and cannot re-stamp `Current` while a `Scheduled` stamp is pending.
   `touch_prices` changes only `updated_at`.
5. `quote_valuation` returns FUND, EXEC and H per `SPEC.md` §4, counts the
   lower of FUND and EXEC, rounds collateral down, and refuses a stale price, a
   mismatched multiplier stamp, and a non-allowlisted mint.
6. I12: H is unchanged across NFLXx's real 10-for-1 split. I13: valuation
   refuses while the stamp and the effective multiplier disagree. I17: both
   halves. I5: the SPEC §10 vectors.
7. No float arithmetic reaches the compiled program.
8. The `harness` cargo feature's `read_clock` cannot reach a default build.

## 5. Where the tests are thin, stated rather than discovered

- `INVARIANTS.md` requires I5, I12, I13 and I17 to be mutation-checked.
  Mutation runs were done for the decoder (9 mutants), the TLV reader
  (5 mutants) and the I17 pending predicate (4 mutants), all recorded in
  `DONE.md`. One equivalent survivor is documented in `valuation.rs`: deleting
  the non-finite branch leaves the suite green because those patterns overflow
  and are refused anyway. Nothing else was mutation-checked.
- `quote_valuation` is the only instruction that consumes `value_position`.
  Gate 2's three consumers do not exist, so the shared sequence has one caller.
- Compute units are recorded for `quote_valuation` only, at ~4800. `SPEC.md`
  NFR-3's n = 8 claim is gate 2's to measure.
- The T00 suites run inside `anchor test` and are fully offline; every endpoint
  they exercise is a localhost stub. Nothing in the test path ever contacts the
  real RPC or the real issuer, so the fixtures' provenance is asserted by
  recorded evidence rather than re-verified on each run.

## 6. Out of scope for this review

- Gates 2 to 5. Not written.
- `PROPOSAL-solo-mode.md`. Separate design review, r4, in progress.
- The design pack itself: `SPEC.md`, `INVARIANTS.md`, `ARCHITECTURE.md`, the
  ADRs. Four design review rounds already passed on those.
- Whether the chosen harness is bankrun rather than LiteSVM. Recorded in
  `DONE.md` P1 with the measurements.

## 7. Open items, already recorded. Do not re-report unless the statement is wrong

Full text in `OPEN-QUESTIONS.md`. Summarised:

1. **BLOCKING before T23, unauthenticated oracle takeover.** `init_price_feed`
   has no authority gate. `SPEC.md` §5 puts it on the admin row and lists
   `unauthorized`, but §4 defines no admin or config account to check against.
   First caller becomes `feed.authority` and can then set arbitrary prices. The
   required shape is a bootstrap authority root that `init_price_feed` must
   require. Unexploitable locally; real on any cluster.
2. **BLOCKING before T23.** Deployment network undecided.
3. `quote_valuation`'s signature: `SPEC.md` §5 writes `quote_valuation(raw)`
   with accounts "mint + feed", but `h` needs `haircut_bps` and `price_stale`
   needs `max_price_age`, neither reachable from those accounts. Implemented as
   arguments; reading recorded for the design session.
4. A feed stamped ahead of the clock gives a negative age and passes the
   freshness check. Behaviour question, left for the design session.
5. Clock-warp harness ADR not yet written. `OPEN-QUESTIONS.md` line 1 says
   ADR-011, which is already Jupiter price units; that number is stale.
6. Mint allowlist is a hardcoded const, per ADR-012.
7. Borrow Solo and the deferred Open-circle mode.

## 8. KNOWN-LIMITS.md, verbatim. Do not re-report unless the statement itself is wrong

# Known limits

Accepted tradeoffs. Reviews do not re-report these unless the statement itself is wrong.

| # | limit | why accepted | recorded at gate | revisit at |
|---|---|---|---|---|
| L1 | Devnet only; a single demo admin key sets prices, seeds the pool and changes the mint multiplier | hackathon, $0; stated on the site | design | mainnet |
| L2 | Program upgrade authority is Joshua's single devnet key | devnet | design | mainnet (multisig + timelock) |
| L3 | Pre-payout default (a member who has not received yet) is unsupported; they can still pay late | out of scope in SPEC v4 | design | post-hackathon |
| L4 | No exit from Active without a successful payout (no dissolve) | create-time peak check makes it unreachable without a default or price fall | design r2 | post-hackathon |
| L5 | Coverage-based default ("critical past cure window", SPEC v4 §5) cut; only missed contributions default | time; supersedes SPEC v4 §5 | design r2 | post-hackathon |
| L6 | Rounding dust stays in vaults; Member accounts not closed (rent locked) | simplicity | design | post-hackathon |
| L7 | Issuer powers of real xStocks (pause, freeze, permanent delegate) not handled; mock mint has none | devnet mock | design | mainnet |
| L8 | pool_insufficient reverts a default until the admin reseeds the pool | devnet mock | design | mainnet (real route) |
| L9 | next_gate_short_by (Paused) is as of the last refresh; the Repricing-branch value is approximate | no keeper | design r4 | post-hackathon |
| L10 | No keeper; every transition needs someone to send a transaction | Solana has no cron | design | never (by design) |
| L11 | One stock per circle | scope | design | post-hackathon |
| L12 | Tier 1 design depth for a money-holding program | deadline; four review rounds compensate | design | mainnet (Tier 2 + audit) |
| L13 | "Removed from future circles" claim dropped; default is recorded only in its circle | no cross-circle record | design | post-hackathon |
| L14 | Top-ups that fill an escrow deficit are not returned | they prefund a defaulter's contributions | design r3 | never (by design) |

## 9. Output

Verdict on the first line, exactly one of:

```
VERDICT: implementation-ready
VERDICT: changes required
```

Then findings as CRITICAL / MAJOR / MINOR, each with `path:line`, what breaks,
and the smallest change that fixes it. Then U8: what could not be checked, and
why.
