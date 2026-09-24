VERDICT: changes required

Reviewed commit: `37f2931` (`origin/staging..37f2931`). This is the Gate 2
r3 re-review of r2 at `7307806`.

## r1 and r2 findings

- **CRITICAL — fixed.** `leave_forming` is Forming-only, binds the signer to
  their own Member PDA, returns their stock and settled USDC under the Circle
  PDA, reverses the joined and settlement fields, and closes the Member account
  for a clean rejoin. The stalled three-seat scenario, rejoin, lifecycle
  refusals, cancellation of a remaining member, and I3 accounting pass.
- **MAJOR — fixed.** The harness proves the previously missing
  `AlreadyDefaulted` and `MultiplierInvalid` refusals; all 22 declared error
  variants now have a negative assertion.
- **r2's n=3 peak correction — fixed.** `peak_for_the_smallest_circle_is_ten`
  makes the formerly incorrect fixture comment load-bearing.
- **r2's SPEC mismatch — fixed.** `SPEC.md:58` now defines settled deposits
  and `SPEC.md:104` specifies `leave_forming`, matching the program.
- **r2's count table — partly fixed.** Its 8-use/14-constraint table is now
  correct, but the re-review range and a second count in the same brief remain
  stale; see finding 1.

## MINOR — INSIDE — the gate brief still names an older review target and a smaller account surface

`reviews/gate-2-brief.md:13-14` identifies `44cc1e5` and
`origin/staging..62d5f74`, while this re-review is `37f2931` and
`origin/staging..37f2931`. Its runbook at `:45-48` still tells the reviewer to
check out `62d5f74` and expects 85 Anchor / 43 Cargo tests; the current commit
has 92 / 44. Despite the corrected 8-use table, `:106-107` also asks whether
`init_if_needed` is safe on "all five uses".

This is a U2 failure in a gate-review map: it points reviewers at a smaller,
older surface than the one whose verdict is meant to close the PR. Update the
commit, range, command output, and that stale five-use reference together.

## MINOR — OUTSIDE — the design pack's user and audit consumers still describe the old no-exit lifecycle

The new canonical instruction row was added, but downstream authoritative
consumers were not reconciled:

- `SPEC.md:175` says Member accounts are not closed in the prototype, whereas
  `leave_forming` closes one. Scope that statement to terminal `withdraw`, or
  state the Forming exception.
- `SPEC.md:213` tells a newly joined Forming member their stock is locked until
  the circle ends. That is false after `leave_forming`, and no Join/Position
  copy exposes the recovery action.
- `ARCHITECTURE.md:79-85` omits `leave_forming` from the Member role and omits
  `MemberLeftForming` from its stated event-per-state-change audit surface.

The code no longer strands assets, but the documented product path still tells
the affected member they cannot use the recovery and leaves auditors with an
incomplete event map. Re-hand the design pack with those consumers reconciled;
the build must not edit them.

## U7

INSIDE: 1. OUTSIDE: 1. Indicative only: this was a single-prompt re-review and
the r1/r2 findings and changed locations were visible before review.

## U8 — not checked

- No cluster transaction or deployment was performed; the tests use bankrun.
- T14-T16 remain out of scope: pool funding, the default waterfall, top-ups,
  escrow deficits, and non-degenerate Completed withdrawal are still not
  executed in this Gate 2 review.
- Existing recorded limits remain unreviewed here, including issuer-controlled
  Token-2022 extensions, direct third-party ATA deposits, price-feed bootstrap
  authority, the USDC-mint policy, and stale-feed liveness.

## Verification run

Run sequentially at `37f2931`:

```
anchor build
anchor test
cargo test -p othello
cargo clippy --all-targets -- -D warnings
cargo fmt --check
pnpm exec tsc --noEmit -p tsconfig.json
```

All passed. Anchor reported 92 passing; Cargo reported 44 passing; clippy,
formatting, and TypeScript checking were clean.
