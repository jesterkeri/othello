EARLY FINDINGS (T09 structural, not a gate 2 verdict)

Reviewed commit: `9ffe86c` only (`origin/staging..9ffe86c`). This is an early
T09 structural review, not a Gate 2 review and does not close any task or
gate.

## MAJOR — OUTSIDE (root: T08 parameter admission; manifests in T09): a circle can accept a guarantee total its vault and accounting fields cannot represent

`programs/othello/src/instructions/create_circle.rs:196-200` compares the
peak against `n * guarantee_per_member` in `u128`, but
`Circle.reserve_total` and `Circle.deposits_total` are `u64`
(`programs/othello/src/state.rs:87-103`). T09 then transfers each guarantee
into one token account and adds it to those `u64` fields
(`programs/othello/src/instructions/join_and_lock.rs:207-249`). There is no
requirement that `n * guarantee_per_member <= u64::MAX`.

Concrete sequence: create a three-member circle with a negligible peak and
`guarantee_per_member = 2^63`. Creation succeeds because its `u128` reserve
is sufficient. The first join succeeds. The second cannot credit another
`2^63` to the same USDC vault (its amount is a `u64`), and the subsequent
checked accounting add would overflow too. The transaction rolls back, but
the first member has already locked funds into a circle that can never reach
Active; at this stage its only escape is a creator cancellation and the
unimplemented T12 withdrawal path.

This is not an arithmetic failure that `checked_add` solves: it is an
invalid configuration accepted before anyone deposits. Reject it in
`create_circle` by making the representability bound explicit (at minimum,
`guarantee_per_member <= u64::MAX / n`) and add a boundary test that fails at
creation, not on a later join. The brief's test suite exercises ordinary
guarantees only.

## MAJOR — OUTSIDE (root: T08 parameter admission; manifests in T09): `round_secs` is claimed bounded but has no upper bound, so a validly created and fully funded circle can never activate

`programs/othello/src/instructions/create_circle.rs:174-177` accepts every
`round_secs >= 60`. In contrast,
`programs/othello/src/instructions/lifecycle.rs:71-75` says it is bounded at
creation and uses `now.checked_add(circle.round_secs)`. At any normal
positive Unix time, a circle created with `round_secs = i64::MAX` can accept
all joins but `activate` returns `InvalidParams` on the deadline addition.
The transaction rolls back to Forming, leaving the deposits locked pending
the same cancellation/withdraw route.

The documented activation surface promises only `not_all_joined`; it does
not describe a late parameter refusal after members have deposited. Define a
real maximum round duration in the design and enforce it at creation, then
test that an out-of-range duration is refused before a member can join. Make
the corresponding upper-bound decision for `grace_secs` now as well: T15
will need to form `deadline + grace_secs` and otherwise inherits the same
late-overflow failure.

## No finding in the three T09 account-structure decisions

For this commit, the ATA constraints bind each supplied token account to the
specified mint, authority, and selected Token/SPL-Token-2022 program. The
two CPIs are transaction-atomic, and the direct mint-data borrow ends before
either CPI. The `n == 8` bitmap branch correctly avoids `1u8 << 8` and the
tests exercise both `n == 3` and `n == 8`.

## U7

INSIDE: 0. OUTSIDE: 2. Indicative only: this was a single-prompt review, so
the protocol's cold-read measurement is not enforceable here.

## U8 — not checked

- No deployment or cluster transaction was performed.
- I did not execute a bespoke overflow reproduction; the two sequences above
  follow the checked `u64` storage/token-account limits and the explicit
  `checked_add` paths. The provided local suite does not cover either input.
- T10-T12, including payout, withdrawal, and pool initialization, are not
  implemented in the reviewed commit and were not reviewed.
- Issuer-controlled Token-2022 extensions (permanent delegate, hook, paused
  state, default account state) and the documented first-caller price-feed
  authority issue were not re-reviewed; they remain outside this early pass.

## Verification run

The code under test was unchanged after `9ffe86c` (later commits altered only
`TASKS.md` and this brief). On that identical code surface:

```
anchor build
anchor test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

passed: 28 Rust tests and 54 TypeScript tests; clippy and format checks were
clean.
