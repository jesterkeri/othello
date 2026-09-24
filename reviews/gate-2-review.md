VERDICT: changes required

Reviewed frozen target: `045878a` (`origin/staging..045878a`). The checked-out
branch head is `c17ea43`; `git diff 045878a c17ea43 --stat` confirms it changes
only the brief's self-referential target block and this prior verdict, not code
or design text.

## r3 finding 1 — brief target and account surface: fixed

`reviews/gate-2-brief.md:23-29` now names `045878a`, the correct range, and
the independently reproduced `35 files changed, 7,636 insertions(+), 24
deletions(-)` figure. Its table at `:85-91` matches source: `init_if_needed`
is 3/2/1/2 for join_and_lock/leave_forming/release_pot/withdraw (8 total), and
the ATA-account constraint counts are 4/4/2/4 (14 total). The full test run
reports 92 Mocha tests and `cargo test -p othello` reports 44 Rust tests.

## r3 finding 2 — authoritative lifecycle consumers: not fully fixed

`SPEC.md:58,104,175,213,215` and `ARCHITECTURE.md:79-85` now correctly expose
the Forming unwind, its closure exception, its UI action, the Member role, and
`MemberLeftForming` as a built event. However, the required sweep included
KNOWN-LIMITS and that consumer remains false:

- **MINOR — OUTSIDE — `KNOWN-LIMITS.md:12` still says "Member accounts not
  closed."** `leave_forming` closes the joined member's PDA at
  `programs/othello/src/instructions/leave_forming.rs:44-51,184-193`. A
  maintainer or auditor following L6 would conclude that the account/rent stays
  locked and a same-wallet rejoin is impossible, the opposite of the repaired
  lifecycle. Scope L6 to terminal `withdraw`, or name the Forming exception as
  SPEC does.

## New findings

- **MINOR — INSIDE — `programs/othello/src/state.rs:104` retains the old
  `deposits_total` definition.** It calls the field the sum "ever deposited,"
  while `leave_forming.rs:164-179` deliberately subtracts the leaver's settled
  guarantee/top-ups and `SPEC.md:58` now defines that semantics. For example,
  after two joins and one Forming unwind, source documentation predicts 2g but
  the actual field is g. A later consumer using this code-level layout comment
  for Completed-share accounting would use the wrong denominator. Reword it to
  the settled-deposits definition.

- **MINOR — INSIDE — the brief's new U2 claim contradicts its own account
  table.** `reviews/gate-2-brief.md:15-19` says every review-varying figure
  lives only in the target block and the rest does not repeat numbers, but
  `:78-91` repeats the total as "EIGHT" and `8`, alongside the per-instruction
  figures. If another instruction gains an `init_if_needed` use and an editor
  updates only the stated source-of-truth block, the table can again describe a
  smaller account surface—the precise review-map failure r3 repaired. Either
  make the target block the declared source of truth and call section 3 a
  sourced breakdown, or remove the universal "nowhere else" claim.

- **MINOR — INSIDE — `MemberLeftForming` has no regression test.** SPEC requires
  this audit event (`SPEC.md:104`), and the code emits it at
  `leave_forming.rs:184-193`, but `tests/t09b-leave-forming.spec.ts:240-437`
  checks balances, closure, state, and refusals only. Removing that `emit!` or
  supplying an incorrect event payload leaves every current leave-forming test
  green while indexers lose the state transition. Decode and assert the event,
  including wallet, turn, refunded stock/USDC, bitmap, and both settled totals.

I also re-read the whole gate rather than only the r3 diff: T08 creation and
peak check; T09 join/cancel/activate and Forming unwind; T10 contribution,
payout, gate, escrow branch, and refusal events; T11 coverage; T12 withdraw;
and T13's refusal coverage. The 22 declared `OthelloError` variants are each
named in a negative test expectation, including `AlreadyDefaulted` and
`MultiplierInvalid`. I found no further code or arithmetic divergence from
SPEC sections 4-7 or INVARIANTS I1-I4, I6, I10, I11, and I16.

## U7

INSIDE: 3. OUTSIDE: 1. Indicative only, not a blind-review measurement: this
was a single-prompt re-review and r3's locations and proposed repairs were
visible before the cold pass.

## U8 — not checked

- No cluster transaction or deployment was performed; the suite uses bankrun.
- T14-T16 (pool funding, defaults, top-ups, stock additions, and their
  non-degenerate settlement paths) and frontend components are out of scope.
- Recorded limits remain unreviewed except the inaccurate L6 statement above,
  including issuer-controlled Token-2022 extensions, direct ATA deposits,
  price-feed bootstrap authority, USDC-mint policy, and stale-feed liveness.
- The frontend Join and Position components were deliberately not opened: this
  gate verifies the re-handed design copy, not the separate frontend branch.

## Verification

Commands were run serially with
`PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"`.

```
$ git diff --shortstat origin/staging..045878a
 35 files changed, 7636 insertions(+), 24 deletions(-)

$ anchor build
exit=0

$ anchor test
44 Rust tests passed; 92 Mocha tests passed (49s)
OK: 11 binding-record cases, every field is load-bearing
OK: 15 cases, only a mint that proves its identity becomes a fixture
exit=0

$ cargo test -p othello
test result: ok. 44 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
exit=0

$ cargo clippy --all-targets -- -D warnings
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.52s
exit=0

$ cargo fmt --check
exit=0

$ pnpm exec tsc --noEmit -p tsconfig.json
exit=0

$ pnpm exec mocha --import=tsx --reporter dot --timeout 120000 \
    tests/t08-create-circle.spec.ts tests/t09-join-and-lock.spec.ts \
    tests/t09-adversary.spec.ts tests/t09b-leave-forming.spec.ts
29 passing (8s)

$ pnpm exec mocha --import=tsx --reporter dot --timeout 120000 \
    tests/t10-contribute-release.spec.ts tests/t11-update-coverage.spec.ts \
    tests/t13-refusal-coverage.spec.ts
19 passing (13s)

$ pnpm exec mocha --import=tsx --reporter dot --timeout 120000 \
    tests/t10-adversary.spec.ts
9 passing (17s)

$ pnpm exec mocha --import=tsx --reporter dot --timeout 120000 \
    tests/t12-withdraw.spec.ts
4 passing (6s)
```
