# Tasks

One line per task. A task is not complete until its verification command has run and its real output is in DONE.md.
Each gate ends with a refactor pass (R1-R4) that runs BEFORE the Codex brief, so the review sees refactored code, not the first draft. A refactor never weakens a test.
Format: `- [ ] Txx <what> | verify: <exact command> | done when: <observable condition>`

## Gate 1: valuation spike (GO / NO-GO). Do not start gate 2 until G1 is reviewed.
- [x] T00 Fetch real mint fixtures (AAPLx, NFLXx, plus SPYx and NVDAx) into tests/fixtures via getAccountInfo base64, with fetch date and slot | verify: `pnpm tsx ops/fetch-fixtures.ts && ls tests/fixtures` | done when: four fixture files; NFLXx fixture decodes multiplier 1, newMultiplier 10, ts 1763337300
- [x] T01 Anchor workspace per ARCHITECTURE layout; pin toolchain files; record resolved anchor-spl and spl-token-2022-interface versions | verify: `anchor build` | done when: builds; versions pasted in DONE.md
- [x] P1 Harness proof: the chosen clock-warp harness (LiteSVM or bankrun with anchor 1.1.x) loads the real NFLXx mint at its canonical address and sets Clock to exactly 1763337299 and exactly 1763337300, with the T01 program reading each value back | verify: `pnpm tsx tests/p1-harness-proof.ts` | done when: loaded bytes equal tests/fixtures/NFLXx.json dataBase64 and both exact seconds are read back. No multiplier assertions here, those are T03 and T06. If neither harness can do it, stop and report; do not write the ADR
- [x] T02 PodF64 exact decoder (ADR-001) with unit tests | verify: `cargo test -p othello decode` | done when: SPEC §10 G1 vectors pass; NaN/Inf/negative rejected
- [x] T03 Read ScaledUiAmountConfig via StateWithExtensions; TLV-offset fallback as a test only | verify: `anchor test` | done when: both parsers agree on the real AAPLx and NFLXx fixtures
- [x] T04 PriceFeed: init_price_feed, set_prices(stamp, expected_multiplier_fixed), touch_prices | verify: `anchor test` | done when: I17 tests green
- [x] T05 quote_valuation (Clock-selected multiplier, FUND/EXEC/H, return data) | verify: `anchor test` | done when: I5, I12, I13 green; CU logged in DONE.md
- [x] T06 Load the real fixtures into the local validator / LiteSVM at their real addresses and run quote_valuation against them; mint allowlist check (ADR-012) | verify: `anchor test` | done when: NFLXx values at ~10x a naive raw×share read; non-allowlisted mint refused
- [x] R1 Refactor pass before review: fold duplication between the decoder and valuation paths, name every magic number, split any function doing two jobs, delete dead code. No test weakened, skipped or deleted | verify: `cargo clippy --all-targets -- -D warnings && cargo fmt --check && anchor test` | done when: clippy and fmt clean, every gate-1 test still green, before/after diffstat in DONE.md
- [x] T07 Gate 1 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: reviews/gate-1-review.md verdict implementation-ready AND the brief states gate 1 is locally implementation-ready, not deploy-ready (the init_price_feed oracle-takeover block in OPEN-QUESTIONS stands until T23)

## Frontend, built in parallel with gate 2 (Joshua, 2026-09-22)
It is a wallet app, and `HACKATHON.md` records the only published criterion: "could this be a real app that people will actually use?". No correctness proof is required in the app, so the user-facing product is the whole score. All of these render from fixtures and none needs gate 2 finished.
- [x] S3 Landing: the premise in one screen, per design/FRAME.md:24 | verify: `pnpm -C app build && pnpm -C app typecheck` | done when: a reader with no crypto background can say what Othello is after one screen, and the seven-step demo's entry point is obvious
- [ ] S4 Circle place, read-only, no wallet: timeline, member table, reserve, whose turn, the countdown | verify: `pnpm -C app build` | done when: every FLOWS section 7 Circle state renders from a fixture
- [ ] S5 Join and Position: what you put in and what comes back, stated before the button (design/UX-REVIEW.md STOP) | verify: `pnpm -C app build` | done when: Join names both amounts and the max loss before the action
- [ ] S1 DEMOTED 2026-09-22, build only after S3 to S5. Split lab: naive vault vs Othello side by side on the real NFLXx split, no wallet needed | verify: `pnpm -C app build && pnpm -C app typecheck` | done when: both columns render from the committed NFLXx fixture; naive FUND 16.5 USDC vs Othello 165; H 132 on both sides of 1763337300; the page states whether it is showing recorded mainnet bytes or live devnet
- [ ] S2 Devnet mirror mints: Token-2022 mints with ScaledUiAmountConfig, a labelled devnet allowlist entry that cannot coexist with the mainnet one (ADR-012) | verify: `anchor test` | done when: the mirror set is refused on the mainnet allowlist and accepted on the devnet one, and the label is asserted by a test

## Sequencing decision, 2026-09-22 (Joshua, with Codex)

Nothing in the product is cut. What is cut is DEMO SCOPE, decided at the recording
deadline rather than now.

- Build in task order and keep every adversary pass. They have found a real defect in
  every task so far, including two in gate 1 that the external review then missed.
- Keep gate 2 and gate 3 as SEPARATE Codex reviews (Codex, r1 on this plan): a combined
  review makes the diff larger exactly when money movement and default logic arrive.
- Keep T14, T15 AND T16. Cutting T16 removes I14, "escrow deficit is curable", which
  leaves a defaulted circle permanently Paused and lets the demo visibly deadlock. That
  undercuts the pitch almost as badly as having no default path at all.
- R2 and R3 merge into ONE refactor pass before the last review, but every task still runs
  its own tests immediately after it is implemented, and the final `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` and full suite all stay.
- **Recording deadline: Friday 12:00 Lagos.** Stop building, record T25 against whatever
  is done, submit. That reserves nine hours for the demo, the video and the submission.
  Whatever has not landed by then is described in the README rather than shown.
- T27, the repo tidy, runs after the last code review and before T26, as one approved
  revertible commit.

## Gate 2: circle core
- [ ] T08 create_circle with param ranges and peak-guarantee check | verify: `anchor test` | done when: demo params pass, g=29 refused guarantee_below_peak_need, each range refused
- [ ] T09 join_and_lock (scan members, ATA init), cancel_circle, activate | verify: `anchor test` | done when: refusal codes tested; I4 holds
- [ ] T10 contribute (no time check), release_pot (gate option B, allocations, next round reset, next_gate_short_by) | verify: `anchor test` | done when: I1, I6, I10 green; SPEC §3 table reproduced; no Paused after healthy payouts (I18)
- [ ] T11 update_coverage (turn-order allocation, saturating bps, remaining_accounts validation) | verify: `anchor test` | done when: I2 property test green
- [ ] T12 withdraw (snapshot, deposits_total − forfeited_total, zero stock_raw) | verify: `anchor test` | done when: I3, I11, I16 green
- [ ] R2 Refactor pass before review: extract the round-reset and allocation logic shared by contribute, release_pot and update_coverage into one place, collapse repeated account-validation blocks, name every magic number. No test weakened, skipped or deleted | verify: `cargo clippy --all-targets -- -D warnings && cargo fmt --check && anchor test` | done when: clippy and fmt clean, every gate-1 and gate-2 test still green, before/after diffstat in DONE.md
- [ ] T13 Gate 2 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: verdict implementation-ready

## Gate 3: defaults
- [ ] T14 init_pool/seed_pool (discount ≤ haircut enforced at create) | verify: `anchor test` | done when: unauthorized and invalid_params tested
- [ ] T15 declare_default waterfall, both recompute branches, forfeited, escrow_deficit | verify: `anchor test` | done when: I7, I9, I15 green; Repricing branch keeps I2
- [ ] T16 top_up_reserve (deficit first, closed-form next_gate_short_by), add_stock | verify: `anchor test` | done when: I14, I18 green; SPEC §7 halt example: needed 75, remaining 70, short_by 5, top-up 5 resumes
- [ ] R3 Refactor pass before review: bring both recompute branches of the waterfall into one reviewable shape, extract the shared checked arithmetic into named helpers, remove any duplication introduced by top_up_reserve. No test weakened, skipped or deleted | verify: `cargo clippy --all-targets -- -D warnings && cargo fmt --check && anchor test` | done when: clippy and fmt clean, every gate-1 to gate-3 test still green, before/after diffstat in DONE.md
- [ ] T17 Gate 3 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: verdict implementation-ready

## Gate 4: frontend (Next.js, neubrutalist style)
- [ ] T18 App scaffold, read-only Circle place for a viewer with no wallet | verify: `pnpm -C app typecheck && pnpm -C app build` | done when: demo circle renders from devnet accounts without a wallet
- [ ] T19 Transaction statechart (preview, awaiting wallet, submitted, confirmed, failed, expired) and refusal rendering with payload numbers | verify: `pnpm -C app build` | done when: each FLOWS §8 row renders from a fixture
- [ ] T20 Places: Landing, Create, Join, Position, Stock (/api/live), Default, Split lab, Admin | verify: `pnpm -C app build` | done when: every FLOWS §7 state has a fixture screenshot in DONE.md
- [ ] T21 UX acceptance test on one person (design/UX-REVIEW.md) | verify: n/a (human) | done when: their answer pasted in DONE.md
- [ ] R4 Refactor pass before review: extract the repeated place/statechart rendering into shared components, remove duplicated fixture and formatting logic, no inline magic numbers in money rendering. No test weakened, skipped or deleted | verify: `pnpm -C app lint && pnpm -C app typecheck && pnpm -C app build` | done when: lint and typecheck clean, every FLOWS state still renders, before/after diffstat in DONE.md
- [ ] T22 Gate 4 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: verdict implementation-ready

## Gate 5: demo and submission (Joshua)
- [ ] T23 Devnet deploy by Joshua (PREFLIGHT first) | verify: `solana program show <PROGRAM_ID> --url devnet` | done when: program id recorded
- [ ] T24 ops/seed-demo-circle.ts with SPEC §5 demo parameters | verify: `pnpm tsx ops/seed-demo-circle.ts --cluster devnet` | done when: circle address recorded; all five joined before the split
- [ ] T25 Seven-step demo run + video | verify: n/a (human) | done when: video link in DONE.md
- [ ] T27 Repo tidy before the repo is a judged artifact (Joshua, 2026-09-22: "after we are done building you'll have to delete all the unimportant information"). Joshua approves the list before anything is deleted | verify: `anchor test && ./scripts/check-reviews.sh && git log --oneline -1` | done when: the list is approved, the deletions are one commit, and CI is still green
- [ ] T26 Submit on Stocklana; run ops/touch-prices.ts at submission | verify: n/a (human) | done when: submission link in DONE.md before Fri 25 Sep 21:00 Lagos
