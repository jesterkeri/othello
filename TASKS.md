# Tasks

One line per task. A task is not complete until its verification command has run and its real output is in DONE.md.
Format: `- [ ] Txx <what> | verify: <exact command> | done when: <observable condition>`

## Gate 1: valuation spike (GO / NO-GO). Do not start gate 2 until G1 is reviewed.
- [ ] T01 Anchor workspace per ARCHITECTURE layout; pin toolchain files; record resolved anchor-spl and spl-token-2022-interface versions | verify: `anchor build` | done when: builds; versions pasted in DONE.md
- [ ] T02 PodF64 exact decoder (ADR-001) with unit tests | verify: `cargo test -p othello decode` | done when: SPEC §10 G1 vectors pass; NaN/Inf/negative rejected
- [ ] T03 Read ScaledUiAmountConfig via StateWithExtensions; TLV-offset fallback as a test only | verify: `anchor test` | done when: both parsers agree on a mock mint and on the verified AAPLx bytes
- [ ] T04 PriceFeed: init_price_feed, set_prices(stamp, expected_multiplier_fixed), touch_prices | verify: `anchor test` | done when: I17 tests green
- [ ] T05 quote_valuation (Clock-selected multiplier, FUND/EXEC/H, return data) | verify: `anchor test` | done when: I5, I12, I13 green; CU logged in DONE.md
- [ ] T06 ops/create-mock-mint.ts and ops/schedule-split.ts against localnet | verify: `pnpm tsx ops/create-mock-mint.ts --cluster localnet` | done when: mint shows scaledUiAmountConfig; split schedules
- [ ] T07 Gate 1 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: reviews/gate-1-review.md verdict implementation-ready

## Gate 2: circle core
- [ ] T08 create_circle with param ranges and peak-guarantee check | verify: `anchor test` | done when: demo params pass, g=29 refused guarantee_below_peak_need, each range refused
- [ ] T09 join_and_lock (scan members, ATA init), cancel_circle, activate | verify: `anchor test` | done when: refusal codes tested; I4 holds
- [ ] T10 contribute (no time check), release_pot (gate option B, allocations, next round reset, next_gate_short_by) | verify: `anchor test` | done when: I1, I6, I10 green; SPEC §3 table reproduced; no Paused after healthy payouts (I18)
- [ ] T11 update_coverage (turn-order allocation, saturating bps, remaining_accounts validation) | verify: `anchor test` | done when: I2 property test green
- [ ] T12 withdraw (snapshot, deposits_total − forfeited_total, zero stock_raw) | verify: `anchor test` | done when: I3, I11, I16 green
- [ ] T13 Gate 2 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: verdict implementation-ready

## Gate 3: defaults
- [ ] T14 init_pool/seed_pool (discount ≤ haircut enforced at create) | verify: `anchor test` | done when: unauthorized and invalid_params tested
- [ ] T15 declare_default waterfall, both recompute branches, forfeited, escrow_deficit | verify: `anchor test` | done when: I7, I9, I15 green; Repricing branch keeps I2
- [ ] T16 top_up_reserve (deficit first, closed-form next_gate_short_by), add_stock | verify: `anchor test` | done when: I14, I18 green; SPEC §7 halt example: needed 75, remaining 70, short_by 5, top-up 5 resumes
- [ ] T17 Gate 3 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: verdict implementation-ready

## Gate 4: frontend (Next.js, neubrutalist style)
- [ ] T18 App scaffold, read-only Circle place for a viewer with no wallet | verify: `pnpm -C app typecheck && pnpm -C app build` | done when: demo circle renders from devnet accounts without a wallet
- [ ] T19 Transaction statechart (preview, awaiting wallet, submitted, confirmed, failed, expired) and refusal rendering with payload numbers | verify: `pnpm -C app build` | done when: each FLOWS §8 row renders from a fixture
- [ ] T20 Places: Landing, Create, Join, Position, Stock (/api/live), Default, Split lab, Admin | verify: `pnpm -C app build` | done when: every FLOWS §7 state has a fixture screenshot in DONE.md
- [ ] T21 UX acceptance test on one person (design/UX-REVIEW.md) | verify: n/a (human) | done when: their answer pasted in DONE.md
- [ ] T22 Gate 4 brief for Codex | verify: `./scripts/check-reviews.sh` | done when: verdict implementation-ready

## Gate 5: demo and submission (Joshua)
- [ ] T23 Devnet deploy by Joshua (PREFLIGHT first) | verify: `solana program show <PROGRAM_ID> --url devnet` | done when: program id recorded
- [ ] T24 ops/seed-demo-circle.ts with SPEC §5 demo parameters | verify: `pnpm tsx ops/seed-demo-circle.ts --cluster devnet` | done when: circle address recorded; all five joined before the split
- [ ] T25 Seven-step demo run + video | verify: n/a (human) | done when: video link in DONE.md
- [ ] T26 Submit on Stocklana; run ops/touch-prices.ts at submission | verify: n/a (human) | done when: submission link in DONE.md before Fri 25 Sep 21:00 Lagos
