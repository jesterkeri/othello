VERDICT: implementation-ready

Reviewed frozen target: `60fc76e` (`origin/staging..60fc76e`). The checked-out
branch head is `3028b3f`; `git diff 60fc76e 3028b3f --stat` shows only
`reviews/gate-2-brief.md` (6 insertions, 6 deletions), containing the
self-referential review-target bookkeeping. No program or design content differs
between the target and head.

## r5 finding — fixed

`reviews/gate-2-brief.md:80-96` now presents section 3 as only the four
per-instruction rows (join_and_lock 3, leave_forming 2, release_pot 1,
withdraw 2). The former total row is gone. The exact commit, range, size, test
counts, and total-use figure occur only in the Review target block, except for
the necessary checkout/head references to its commit. A direct search found no
second occurrence of the target's commit, range, diff size, 93-test count,
44-test count, or eight-use total.

The target block was independently reproduced:

```
$ git diff --shortstat origin/staging..60fc76e
 36 files changed, 7708 insertions(+), 26 deletions(-)

$ rg -c 'init_if_needed' programs/othello/src/instructions/{join_and_lock,leave_forming,release_pot,withdraw}.rs
join_and_lock: 3
leave_forming: 2
release_pot: 1
withdraw: 2
```

## Earlier r4 repairs — still fixed

- `KNOWN-LIMITS.md:12` scopes the Member-account closure limit to `withdraw`
  and names `leave_forming` as the rejoin exception, matching SPEC §7 and the
  account close constraint.
- `programs/othello/src/state.rs:104-108` defines `deposits_total` as currently
  settled deposits, consistent with SPEC §4 and `leave_forming`'s checked
  subtraction.
- `tests/t09b-leave-forming.spec.ts:306-340` decodes `MemberLeftForming` and
  checks circle, wallet, turn, stock, USDC, bitmap, reserve total, deposits
  total, and the resulting Circle account. The event test passed in the full
  suite.

## Whole-gate result

I re-reviewed T08 create_circle, T09 join_and_lock/lifecycle/leave_forming,
T10 contribute/release_pot, T11 update_coverage, T12 withdraw, and T13 refusal
coverage against SPEC sections 4-7 and INVARIANTS. The 22 declared
`OthelloError` variants remain covered by negative test expectations, including
harness-driven `AlreadyDefaulted` and `MultiplierInvalid`. No new code,
arithmetic, account-constraint, lifecycle, or design-pack contradiction was
found in this gate.

## U7

INSIDE: 0. OUTSIDE: 0. Indicative only, not a blind-review measurement: r6 was
a single-prompt re-review that named its predecessor's issue and repair
criteria before the cold pass.

## U8 — not checked

- No cluster transaction or deployment was performed; the suite uses bankrun.
- T14-T16, the R2/R3 refactor, frontend work, and the upgrade-authority root
  are out of scope.
- Recorded limits were treated as context, including issuer-controlled
  Token-2022 extensions, direct ATA deposits, price-feed bootstrap authority,
  USDC-mint policy, and stale-feed liveness.

## Verification

Commands ran serially with
`PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"`.

```
$ anchor build
Finished `release` profile [optimized] target(s) in 0.23s
Finished `test` profile [unoptimized + debuginfo] target(s) in 0.16s
exit=0

$ anchor test
44 Rust tests passed
93 Mocha tests passed (53s)
OK: 11 binding-record cases, every field is load-bearing
OK: 15 cases, only a mint that proves its identity becomes a fixture
exit=0

$ cargo test -p othello
test result: ok. 44 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
exit=0

$ cargo clippy --all-targets -- -D warnings
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.16s
exit=0

$ cargo fmt --check
exit=0

$ pnpm exec tsc --noEmit -p tsconfig.json
exit=0
```
