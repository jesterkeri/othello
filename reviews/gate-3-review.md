VERDICT: implementation-ready

# Gate 3 r2 — review of `c26fb31..011a4ae`

The frozen target relationship is correct. `git diff 011a4ae 9e8aa34 --stat`
reports only `reviews/gate-3-brief.md` (4 insertions, 4 deletions). The brief's
figures recompute: 32 files changed, 5,203 insertions and 130 deletions; 21
isolated spec files / 144 passing tests; 54 Rust unit tests; and 10
`init_if_needed` constraints (join 3, leave 2, release 1, withdraw 2,
init_pool 2).

## r1 findings

### MINOR — INSIDE — deficit-fill settlement policy: fixed

`KNOWN-LIMITS.md:20` now states the adopted r8 decision: an escrow-deficit
fill is a deposit, shared pro rata at settlement and potentially returned at
less than its original amount after losses. That agrees with `SPEC.md:113`,
`SPEC.md:172-173`, and `SPEC.md:228`, and with the full-amount accounting in
`programs/othello/src/instructions/top_up_reserve.rs:155-171` and withdrawal
weight in `programs/othello/src/instructions/withdraw.rs:133-153`.
`OPEN-QUESTIONS.md:463-496` marks the r8 I14, deficit-fill, and I18 items
resolved while retaining their historical context. The previous contradictory
promise is gone.

### MINOR — INSIDE — malformed remaining Member accounts: fixed

`programs/othello/src/instructions/update_coverage.rs:102-128` maps every
`Account::try_from` failure to `BadMemberAccounts`; shared callers
`update_coverage` and `declare_default` therefore have the documented
machine-code refusal. `programs/othello/src/instructions/release_pot.rs:166-176`
does the equivalent mapping before valuing any seat. The regression at
`tests/t15-declare-default.spec.ts:523-592` exercises system-owned,
wrong-discriminator, and other-program accounts across all three
instructions, each asserting `BadMemberAccounts`.

The related adversary test is now load-bearing:
`tests/t15-adversary.spec.ts:372-397` supplies the reordered, duplicated,
read-only, or short list as `declareIx`'s only remaining-account list. It no
longer accidentally appends a second honest list and passes merely at the
length check; each altered valid Member list reaches the seat-order or
writability validation and refuses with `BadMemberAccounts`.

## Re-review evidence

I rechecked the Gate 3 surface, not only the r1 patch: ProgramData binds the
admin bootstrap to this program's upgrade authority; `init_pool` enforces
classic-SPL USDC and PDA-bound vault ATAs; the waterfall sells only up to the
conservative obligation, books reserve loss / escrow / deficit consistently,
and is safe in both normal and Repricing recomputation branches. The shared
recompute preserves the allocation bound and turn order. `top_up_reserve`
fills deficit before reserve while the full deposit participates in settlement;
`add_stock` affects only the signing member's collateral. Refusal ordering in
the new handlers agrees with SPEC §5. No new findings.

## U7

Indicative only: this was a single-prompt review, so the protocol's cold-read
measurement is not rigorous. Findings: INSIDE 0; OUTSIDE 0.

## U8 — not checked

I did not deploy or seed on devnet, test real Token-2022 transfer hooks or
transfer-fee extensions on the allowlisted stock mints, review frontend code,
or run a full single-process `anchor test`; the repository records that runner
as intermittently stalling. I used the required per-spec-file runner instead.
Pre-payout defaults, multi-default deficit shapes, matchmaking, solo mode, and
chat remain out of scope as stated.

## Verification commands and real output

```text
$ git diff --shortstat c26fb31..011a4ae
 32 files changed, 5203 insertions(+), 130 deletions(-)

$ git diff 011a4ae 9e8aa34 --stat
 reviews/gate-3-brief.md | 8 ++++----
 1 file changed, 4 insertions(+), 4 deletions(-)

$ anchor build
exit 0
Program ID mismatch detected for program 'othello' (local generated keypair
versus source declaration); build completed successfully.

$ for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
exit 0 — 21 spec files, 144 passing

$ cargo test -p othello
exit 0 — 54 passed; 0 failed; 0 ignored

$ cargo clippy --all-targets -- -D warnings
exit 0

$ cargo fmt --check
exit 0

$ pnpm exec tsc --noEmit -p tsconfig.json
exit 0

$ git diff --check c26fb31..011a4ae
exit 0
```
