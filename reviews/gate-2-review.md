VERDICT: changes required

Reviewed frozen target: `17b5d4d` (`origin/staging..17b5d4d`). The checked-out
branch head is `192c3be`; `git diff 17b5d4d 192c3be --stat` reports one changed
file, `reviews/gate-2-brief.md`, with 8 insertions and 8 deletions. It changes
the review-target bookkeeping only, not program or design code.

## r4 findings

1. **OUTSIDE — fixed.** `KNOWN-LIMITS.md:12` now scopes the rent-locked Member
   account claim to `withdraw` and names `leave_forming` as the closure/rejoin
   exception. This agrees with `SPEC.md:175` and the `close = wallet` constraint
   in `programs/othello/src/instructions/leave_forming.rs:44-51`.

2. **INSIDE — fixed.** `programs/othello/src/state.rs:104-108` now calls
   `deposits_total` currently settled deposits, explicitly says the Forming
   unwind subtracts its own deposit, and gives the two-joins/one-unwind `g`,
   not `2g`, example. That matches `SPEC.md:58` and the checked subtractions at
   `leave_forming.rs:164-179`.

3. **INSIDE — not fixed.** The target block is now declared the source of
   truth and its figures are correct, but the claimed per-instruction-only
   breakdown still repeats the total at
   `reviews/gate-2-brief.md:94`: `| **total** | **8** | **14** |`. The r5
   acceptance condition was that section 3 no longer restate the total. If a
   future instruction adds an `init_if_needed` use and an editor updates only
   the target block, this stale row recreates the smaller account-surface map
   that r3/r4 found. Remove the total row; the four instruction rows remain the
   requested breakdown and their sum is independently checkable.

4. **INSIDE — fixed.**
   `tests/t09b-leave-forming.spec.ts:306-340` sends `leave_forming`, decodes
   `MemberLeftForming`, and asserts circle, wallet, turn, stock, USDC,
   joined bitmap, reserve total, and deposits total. It also compares all
   mutable event fields against the post-instruction Circle account. The full
   suite passes this new test. It is structurally load-bearing: without the
   event decoder, `assert.ok(e)` fails; a changed checked field fails its exact
   assertion. I did not mutate frozen source to repeat the recorded mutation.

## Whole-gate result

I re-reviewed T08 create_circle, T09 join_and_lock/lifecycle/leave_forming,
T10 contribute/release_pot, T11 update_coverage, T12 withdraw, and T13 refusal
coverage against SPEC sections 4-7 and INVARIANTS. The 22 declared
`OthelloError` variants remain represented by negative test expectations,
including the harness-driven `AlreadyDefaulted` and `MultiplierInvalid` cases.
No new code, arithmetic, account-constraint, or lifecycle finding emerged.

The figures in the review target are independently correct:

```
git diff --shortstat origin/staging..17b5d4d
 36 files changed, 7733 insertions(+), 26 deletions(-)

init_if_needed from source
join_and_lock 3; leave_forming 2; release_pot 1; withdraw 2; total 8
```

## U7

INSIDE: 1. OUTSIDE: 0. Indicative only, not a blind-review measurement: this
single-prompt r5 named the r4 locations and repair criteria before the cold
pass. An all-INSIDE result is a warning about that framing, not evidence of a
neutral review.

## U8 — not checked

- No cluster transaction or deployment was performed; tests use bankrun.
- T14-T16, frontend work, and the upgrade-authority root are out of scope.
- Recorded limits are context rather than re-reviewed findings, including
  issuer-controlled Token-2022 extensions, direct third-party ATA deposits,
  price-feed bootstrap authority, USDC-mint policy, and stale-feed liveness.
- I did not mutate the frozen program to re-prove the previously recorded
  event-test mutations; the source-level assertion path was inspected and the
  test was executed.

## Verification

Commands ran serially with
`PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"`.

```
$ anchor build
Finished `release` profile [optimized] target(s) in 0.19s
Finished `test` profile [unoptimized + debuginfo] target(s) in 0.24s
exit=0

$ anchor test
44 Rust tests passed
93 Mocha tests passed (53s), including MemberLeftForming payload coverage
OK: 11 binding-record cases, every field is load-bearing
OK: 15 cases, only a mint that proves its identity becomes a fixture
exit=0

$ cargo test -p othello
test result: ok. 44 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
exit=0

$ cargo clippy --all-targets -- -D warnings
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.14s
exit=0

$ cargo fmt --check
exit=0

$ pnpm exec tsc --noEmit -p tsconfig.json
exit=0
```
