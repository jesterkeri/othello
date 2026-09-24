VERDICT: changes required

Reviewed commit: `62d5f74` only (`origin/staging..62d5f74`). Gate 1 code in
that range was previously reviewed; this review traced T08-T12 and the account
and lifecycle shape they add. This is a single-prompt review, so U7's
INSIDE/OUTSIDE measurement is indicative, not a rigorous cold-read result.

## CRITICAL — OUTSIDE — a joined member has no way to recover assets from a Forming circle when the creator does not cooperate

`SPEC.md:102-104` makes joining move a member's stock and guarantee, requires
every seat before activation, and grants cancellation only to the creator.
The implementation follows that exactly:
`programs/othello/src/instructions/lifecycle.rs:15-44` accepts only the
creator for `cancel_circle`, and
`programs/othello/src/instructions/withdraw.rs:121-130` refuses withdrawal
unless the circle is Completed or Cancelled.

Sequence: a creator names A, B and a wallet that never joins (whether an
unresponsive normal wallet or an unusable public key). A and B call
`join_and_lock`; their stock and guarantees are now in the circle ATAs. The
last seat never joins, so `activate` can never pass. If the creator simply
does nothing, neither A nor B can cancel or withdraw. Their assets are locked
indefinitely; this is not merely a failed attempt to create a circle.

The same availability failure occurs whenever formation stalls, without a
malicious or invalid last key. An on-curve check would not fix it. The design
needs a recovery path that does not depend on the creator—for example a
permissionless or joined-member cancellation after a recorded formation
expiry, or a Forming-state member unwind—and its accounting/refusal behaviour
must then be implemented and scenario-tested. This is a SPEC-level correction,
not a local implementation choice.

## MAJOR — INSIDE — G2's required negative coverage is missing, and both stated reasons are testability errors rather than blockers

`SPEC.md:270` requires a negative test for every section 5 refusal code. The
brief correctly says `MultiplierInvalid` and `AlreadyDefaulted` lack one, so
the reviewed commit cannot satisfy G2 as written.

Neither test needs a production default transaction. The harness already loads
accounts at chosen addresses and writes their bytes. It can set the
`defaulted_bitmap` for a constructed Circle and assert that
`contribute` refuses `AlreadyDefaulted` before its transfer
(`programs/othello/src/instructions/contribute.rs:68-99`). Likewise it can
replace the bytes at an allowlisted mint address with an initialized
Token-2022 mint whose scaled multiplier is invalid, then assert that the
T09/T10/T11 valuation path returns `MultiplierInvalid`. Production allowlisting
does not prevent a hostile-byte harness test at that same canonical address.

Add those negative tests, or have the design owner narrow G2's clause. Until
then this gate is not implementation-ready on its own declared done-when.

## MINOR — INSIDE — the brief's completeness counts omit one `init_if_needed` account and misstate the per-instruction ATA constraints

`reviews/gate-2-brief.md:75-86` says there are five `init_if_needed` uses and
two associated-token constraints in each instruction. The source has six
uses: three in `join_and_lock` (`join_and_lock.rs:88-115`), one in
`release_pot` (`release_pot.rs:60-67`), and two in `withdraw`
(`withdraw.rs:57-73`). The corresponding ATA constraints are four, two, and
four, respectively.

This does not make the constraints unsound—the six reviewed constraints bind
their mint, authority and selected token program—but it is a U2 failure in the
review map. Correct the brief/DONE evidence so a future reviewer is not told a
smaller account surface than exists.

## U7

INSIDE: 2. OUTSIDE: 1. Indicative only, because the prompt and its concerns
were visible in the same message as the source scope.

## U8 — not checked

- No deployment or cluster transaction was performed; Token-2022 movement was
  exercised only in bankrun with the dumped Token-2022 program.
- The default/escrow, reserve-loss, escrow-deficit and non-degenerate
  withdrawal paths remain unwritten or unreachable before T15/T16 and were
  not cleared by this review.
- Issuer-controlled extension changes, direct third-party ATA deposits, the
  first-caller price-feed authority issue, the chosen USDC-mint policy, and
  stale-feed liveness remain the separately recorded open items; I did not
  re-review them here.
- I did not create a bespoke transaction reproducing the Forming lock: the
  absence of a callable member exit is explicit in the reviewed instruction
  surface, and every normal state transition in the sequence is covered by the
  existing tests.

## Verification run

The program/test sources are unchanged between `62d5f74` and the review
branch head (only evidence, task tracking and this gate brief were added). I
ran the following sequentially on that identical code surface:

```
anchor build
anchor test
cargo test -p othello
cargo clippy --all-targets -- -D warnings
cargo fmt --check
pnpm exec tsc --noEmit -p tsconfig.json
```

All passed: Anchor reported 85 tests and Cargo reported 43 tests; clippy,
formatting and TypeScript type-checking were clean.
