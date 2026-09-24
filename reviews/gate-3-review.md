VERDICT: changes required

# Gate 3 r1 — review of `c26fb31..b0ec52c`

The frozen target relationship is correct. `git diff b0ec52c 11f9e33 --stat`
reports only `reviews/gate-3-brief.md` (6 insertions, 6 deletions), and the
target range is 30 files, 4,962 insertions and 128 deletions. The brief's
other figures also recompute: 21 isolated spec files / 143 passing tests, 54
Rust unit tests, and 10 `init_if_needed` uses (join 3, leave 2, release 1,
withdraw 2, init_pool 2).

## Finding

### MINOR — INSIDE — the design pack gives the opposite settlement promise for an escrow-deficit fill

`KNOWN-LIMITS.md:20` still says that a top-up which fills an escrow deficit
“[is] not returned,” while `SPEC.md:113`, `SPEC.md:172-173`, and
`SPEC.md:228` now define the r8 decision: the entire top-up is credited to
`Member.top_ups` and `Circle.deposits_total`, then shared pro rata at
settlement. The implementation follows that latter rule:
`programs/othello/src/instructions/top_up_reserve.rs:155-171` credits the full
amount and `programs/othello/src/instructions/withdraw.rs:133-153` includes it
in the member's withdrawal weight. `OPEN-QUESTIONS.md:474-484` also still
presents the superseded (a)/(b) choice as unresolved, even though its cited
SPEC §9 copy has already been changed to (a).

Failure scenario: a member fills a 6-USDC escrow deficit and uses L14 to
understand the action as an irrevocable gift. The circle completes; their
top-up increases their settlement weight and they receive its pro-rata share
(possibly less than 6 after losses). The code is financially consistent, but
the recorded limit promises the opposite result. Update L14 and resolve or
historical-mark the stale Open Question to state the adopted r8 rule. No
program change is warranted.

### MINOR — INSIDE — malformed remaining Member accounts bypass the declared `bad_member_accounts` refusal

`programs/othello/src/instructions/update_coverage.rs:102-123`, newly shared
by `declare_default` at `programs/othello/src/instructions/declare_default.rs:249-251`,
uses `Account::try_from(info)?`. A reordered, duplicate, or read-only *valid*
Member account reaches the following `BadMemberAccounts` checks, but a system
account, wrong-owner account, or account without the Member discriminator
returns Anchor's generic `AccountOwnedByWrongProgram` / account-deserialization
error first. That is not the `bad_member_accounts` refusal required by
`SPEC.md:111` for the handler's Member-account validation, and
`tests/t15-adversary.spec.ts:372-395` covers only deserializable Member
accounts.

Failure scenario: a caller supplies a system-owned account as one of
`declare_default`'s required remaining seats. Funds are safe because the
transaction aborts before the waterfall, but a client receives an unmapped
Anchor framework error rather than the documented machine code and cannot
follow the specified recovery path. Map `Account::try_from` failures in
`load_members` to `OthelloError::BadMemberAccounts`, then add a system/wrong
owner and bad-discriminator regression case. This also makes the shared
`update_coverage` path consistent with its own published refusal.

## Review evidence

I traced the new admin path from the ProgramData binding through the recorded
feed/pool authority, the classic-SPL USDC gate, the pool ATA constraints, the
default waterfall's stock sale / reserve-loss / escrow-deficit ledger, and
both post-default recompute branches. `declare_default` follows SPEC §5's
refusal order: active, turn range, grace, paid, received, defaulted, price,
member accounts, then pool liquidity. The normal branch calls the shared
coverage recompute; the Repricing/unreadable-multiplier branch caps preserved
allocations in turn order and adds only the new deficit, as the now-explicit
approximation requires. `top_up_reserve` fills the deficit before reserve and
does not revalue positions; `add_stock` changes only the caller's locked
position. Apart from the remaining-account error mapping above, I found no
financial or authority defect in those paths.

The completeness sweep corroborated the brief's account-surface claim: the
source has exactly ten `init_if_needed` constraints, distributed 3/2/1/2/2 as
above. Changed state is consumed by the withdrawal formula, events, gate
projection, and design copy; the stale policy record above is the consumer
that remains inconsistent.

## U7

Indicative only: this was a single-prompt review, so the protocol's cold-read
measurement is not rigorous. Findings: INSIDE 2; OUTSIDE 0. The all-INSIDE
count is not evidence that framing was neutral.

## U8 — not checked

I did not deploy or seed on devnet, test real Token-2022 transfer hooks or
transfer-fee extensions on the allowlisted stock mints, review the frontend,
or execute a full single-process `anchor test`; the repository records that
run as intermittently stalling. I used the required reliable per-file runner
instead. Pre-payout default, multi-default deficit shapes, matchmaking, solo
mode, and chat remain outside this gate as stated.

## Verification commands and real output

```text
$ git diff --shortstat c26fb31..b0ec52c
 30 files changed, 4962 insertions(+), 128 deletions(-)

$ git diff b0ec52c 11f9e33 --stat
 reviews/gate-3-brief.md | 12 ++++++------
 1 file changed, 6 insertions(+), 6 deletions(-)

$ anchor build
exit 0
Program ID mismatch detected for program 'othello' (local generated keypair
versus source declaration); build completed successfully.

$ for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
exit 0 — 21 spec files, 143 passing

$ cargo test -p othello
exit 0 — 54 passed; 0 failed; 0 ignored

$ cargo clippy --all-targets -- -D warnings
exit 0

$ cargo fmt --check
exit 0

$ pnpm exec tsc --noEmit -p tsconfig.json
exit 0

$ git diff --check c26fb31..b0ec52c
exit 0
```
