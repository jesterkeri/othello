VERDICT: changes required

Reviewed commit: `7307806` (`origin/staging..7307806`). This is the Gate 2
re-review of r1 at `62d5f74`.

## r1 findings

- **CRITICAL — fixed in code, not yet closed in the authoritative pack.**
  `leave_forming` binds the signer to their own Member PDA, is Forming-only,
  returns stock and settled USDC under the Circle PDA, clears the joined bit,
  decrements both settlement totals, and closes the Member account for a clean
  rejoin. The exact stalled three-seat sequence, rejoin, post-activation and
  post-cancellation refusals, and cancellation of a remaining member all pass
  in `tests/t09b-leave-forming.spec.ts`.
- **MAJOR — fixed.** `tests/t13-refusal-coverage.spec.ts` exercises
  `AlreadyDefaulted` from a harness-written Circle state and exercises
  `MultiplierInvalid` with NaN, infinity, negative, negative-zero and zero
  multiplier bytes at the allowlisted mint address. The declared-error enum has
  22 variants and the suite has a negative assertion for each.
- **MINOR — not fixed; see finding 2.** The original 6-use / 4-2-4 table was
  correct for the old three-instruction surface, but it is no longer complete
  after `leave_forming`.

## MAJOR — OUTSIDE — the checked-in authoritative SPEC still contradicts the repaired program

`SPEC.md:58` still defines `deposits_total` as guarantees and top-ups "ever
deposited", and its instruction surface at `SPEC.md:101-115` contains no
`leave_forming` row. In contrast, `leave_forming.rs:163-177` correctly clears
the seat and reverses that member's settled deposit, and it is exposed from
`lib.rs:75-81`.

The supplied design decision resolves the semantic question, but it has not
yet been applied and re-handed as the canonical pack. Under the repository's
authority order, a gate cannot be implementation-ready while its code adds an
instruction and changes accounting contrary to SPEC. Apply the two stated SPEC
edits, then re-run this review.

## MINOR — INSIDE — the re-review brief again reports a smaller `init_if_needed` surface than the code has

`reviews/gate-2-brief.md:75-85` says there are six uses across three
instructions, and `:102` says "all five uses". The new reviewed surface has
eight: join_and_lock 3, release_pot 1, withdraw 2, and leave_forming 2.
Its ATA-constraint table also omits leave_forming's four constraints. The brief
still names `22c55f9`, `origin/staging..62d5f74`, and an 85-test command at
`:13-14` and `:45-47`, none of which identifies this re-review.

This repeats r1's review-map defect: the reader is directed to a smaller
account surface and an older range. Update the brief for `7307806`, including a
4-row table (3/4, 1/2, 2/4, 2/4) and the current verification result.

## MINOR — OUTSIDE — the new fixture's peak-guarantee explanation is false

`tests/t09b-leave-forming.spec.ts:51-54` says the n=3 peak is zero and any
positive guarantee passes. With its own parameters, k=1 yields
`ceil(50 * (3 - 1) * 13000 / 10000) - 120 = 10` USDC, so the peak is 10 and
g=1 fails because 3 * 1 < 10. The test's g=35 still passes, so this does not
mask the asset-return repair; correct the fixture comment before it becomes a
copied parameter example.

## U7

INSIDE: 1. OUTSIDE: 2. Indicative only: this was a single-prompt re-review and
the r1 findings and implementation locations were visible before the review.

## U8 — not checked

- No cluster transaction or deployment was performed; the tests use bankrun.
- T14-T16 remain out of scope, so the default waterfall, pool funding,
  top-ups, escrow deficits and non-degenerate Completed withdrawal remain
  unexecuted in this Gate 2 review.
- Existing recorded limits remain unreviewed here, including issuer-controlled
  Token-2022 extensions, direct third-party ATA deposits, price-feed bootstrap
  authority, the USDC-mint policy and stale-feed liveness.

## Verification run

Run sequentially at `7307806`:

```
anchor build
anchor test
cargo test -p othello
cargo clippy --all-targets -- -D warnings
cargo fmt --check
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec mocha --import=tsx --timeout 120000 tests/t09b-leave-forming.spec.ts tests/t13-refusal-coverage.spec.ts
```

All commands passed. The direct repair/refusal run reported 7 passing; Anchor
reported 92 passing and Cargo reported 43 passing.
