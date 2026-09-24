# Gate 2 review brief: the circle that takes money and pays it out

Gate 1 proved a program could value Token-2022 collateral across a corporate
action. Gate 2 is the protocol built on that: a circle that accepts stock and
guarantees, collects contributions, decides whether a pot may be released, and
gives everything back at the end.

This is the review that closes gate 2. It is not the early T09 structural pass;
that one is at `reviews/gate-2a-t09-brief.md`, was deliberately not a verdict,
and its subject is INCLUDED here, because T10 to T12 landed after it and
invalidated it by design.

## Review target

This block is the SOURCE OF TRUTH for every figure that changes between review
rounds. It has been wrong three times, and every time for the same reason: a
fix corrected the line a reviewer pointed at while the same fact sat restated
further down. Section 3 keeps one sourced BREAKDOWN of the `init_if_needed`
total, per instruction, because a reviewer needs to know where each use is;
it is recounted from source together with this block, never edited alone, and
where the two disagree this block wins and the brief is wrong.

| | |
|---|---|
| branch | `task/T09-join-and-lock` |
| commit | `17b5d4d`, the code and design pack under review (r5) |
| range | `origin/staging..17b5d4d` |
| size | 36 files changed, 7,733 insertions(+), 26 deletions(-) |
| `anchor test` | 93 passing |
| `cargo test -p othello` | 44 passed |
| `init_if_needed` uses | 8, itemised per instruction in section 3 |

Every figure above was produced by running the command, not carried forward:
`git rev-parse`, `git diff --shortstat`, the two test runs, and `grep -c`.

The branch head is ONE commit later than `17b5d4d`. That commit changes only
this block, which cannot name its own hash. It
changes no code and no design text, so `17b5d4d` is the surface to review.

Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`,
U1 to U9. The absolute path is deliberate: it is a cross-project standard in
another repo, and a relative path only resolves if you start a directory above
this one.

## 2. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello
git checkout 17b5d4d                    # the commit in the Review target block
anchor build
anchor test                              # count: Review target block
cargo test -p othello                    # count: Review target block
cargo clippy --all-targets -- -D warnings
cargo fmt --check
pnpm exec tsc --noEmit -p tsconfig.json
```

**Run each of those alone.** Two of them in one shell line fight over `target/`,
and this build reported failures twice that did not exist because of it, once
from two `anchor test` runs and once from `anchor test` racing `cargo fmt`,
which rewrote sources mid-run.

`tests/fixtures/spl_token_2022.so` is the real Token-2022, dumped from devnet
with `solana program dump`. bankrun 0.4.0's own copy predates
`ScaledUiAmountConfig` (extension 25) and `Pausable` (26) and returns
`InvalidAccountData` for every real xStock, so without that file no test that
moves a token can run at all.

## 3. The structural decisions, and why they are here rather than in the early pass

**The circle's vaults are Associated Token Accounts.** T08 tried Anchor's
`init`, which allocates a token account's base 165 bytes; a Token-2022 account
for an extension-carrying mint needs more, and `InitializeAccount3` returned
`InvalidAccountData` against the real mint. ATAs move the sizing to the program
that computes it. The consequence is that the vault address is derived from
(mint, authority) rather than from a seed this program chose, and **anyone can
transfer into it**.

**`anchor-lang` carries the `init-if-needed` feature.** The total is in the
Review target block; this is its per-instruction breakdown, counted from source
at the commit under review and recounted whenever that block is. This table has been
wrong three times: r1 found it undercounting, r2 found it still at six after
`leave_forming` added two more, and r3 found the count restated elsewhere in
the brief after the table itself was right. These figures were counted from source with
`grep -c` at the commit below, not carried forward from the last version:

| instruction | `init_if_needed` | `associated_token` constraints |
|---|---|---|
| `join_and_lock` | 3 | 4 |
| `leave_forming` | 2 | 4 |
| `release_pot` | 1 | 2 |
| `withdraw` | 2 | 4 |

The `init_if_needed` total is the Review target block's figure and is not
restated here.

No Othello state account uses it; `Member` uses plain `init`.

**The gate arithmetic is one module**, `gate.rs`, shared by `release_pot` and
`update_coverage`, and T15's `declare_default` will use it too.

**Two token programs in one instruction.** Stock is Token-2022 and USDC is SPL
Token, so `join_and_lock` and `withdraw` each carry two
`Interface<TokenInterface>` accounts; the constraint counts are in the table
above and are not two per instruction, which is what r1 corrected.

## 4. What to review

All of `programs/othello/src/`, and `tests/harness.ts`. Questions this build
cannot answer about itself:

1. Are the ATA constraints sufficient, in every combination, with two token
   programs present? Can any token account be substituted for another?
2. Is `init_if_needed` safe on every use in the section 3 table, including the
   ones where the payer and the authority are the same untrusted wallet?
3. Three instructions read the mint with `try_borrow_data` while the same mint
   is an `InterfaceAccount<Mint>` in the same context and CPIs follow. Sound?
4. **`next_gate_short_by` is computed in two places**, `release_pot` and
   `update_coverage`. Do they agree in every state? If they can disagree, the
   Paused figure changes depending on which instruction ran last.
5. `release_pot` takes all n Member accounts as writable `remaining_accounts`
   and validates `member.circle == circle && member.turn == index`. Is that
   sufficient to stop the gate being summed over a set the caller chose?
6. The **escrow branch** of `release_pot` is unreachable today, because
   `defaulted_bitmap` can only be set by `declare_default` (T15). It is written
   and untested. Read it against SPEC §6.
7. `withdraw` reads snapshots and decrements nothing, which is how I16 holds.
   Is there any path where a member's share depends on another member acting?
8. Rounding, everywhere: obligations up, collateral down.

## 5. What has already been attacked

Two adversarial passes, each given the spec and the diff and not the reasoning
behind the code.

The first, on T09, ran 23 attacks and found no defect. The second, on T10 to
T12, ran about 40 and found no defect. Their tests are integrated:
`tests/t09-adversary.spec.ts` (5 cases) and `tests/t10-adversary.spec.ts` (9).
The second wrote a differential sweep over 16 prices that re-implements SPEC §4
and §5 in the test and matches the program's pass/refuse decision, its
`reserve_allocated` and its choice of refusal code at every price, and a case
that pins the gate at ONE BASE UNIT where a floored requirement or a `<`
comparison would move the boundary.

**This is not a claim that the code is correct.** It is what has already been
swept, so you can spend the round elsewhere. Note that the T09 pass PASSED a
finding an external reviewer later called a bricked circle: it asked whether
state was corrupted and answered no, without asking what the circle then was.

Already found and fixed, do not re-report: two `create_circle` parameter
admissions that took a member's money and left the circle unable to complete
(`guarantee` where `n x g` exceeds u64, and `round_secs` with no ceiling); an
unreachable `AlreadyJoined` guard whose comment claimed the opposite; dead
`paid_bitmap` writes in `release_pot`; a dead `vaultAddress()` helper; refusal
payloads emitted as `msg!` instead of events; and four tests that asserted
refusals they could not observe, because two byte-identical transactions are
rejected by signature before reaching the program.

## 6. Where the tests are thin, stated rather than discovered

- **G2's third clause is now met: 22 of 22 refusal codes have a negative test.**
  r1 correctly rejected this brief's claim that the last two were structurally
  untestable. They were not; the claim confused "unreachable in production" with
  "untestable". `tests/t13-refusal-coverage.spec.ts` reaches both by writing
  account bytes, which is how every fixture in this repo works: it marks a seat
  defaulted on the Circle account and asserts `contribute` refuses, and it puts
  a mint whose scaled multiplier is NaN, infinity, negative, negative zero or
  zero at the allowlisted address and asserts the valuation path refuses.
- **Everything downstream of a default is unexecuted by anyone.** The escrow
  branch of `release_pot`, `reserve_losses > 0`, `forfeited > 0`,
  `escrow_deficit > 0`, and therefore the non-degenerate pro-rata in `withdraw`,
  where every weight in gate 2 is 35 USDC and every share is 35 USDC. The share
  arithmetic is unit-tested with asymmetric inputs in `withdraw.rs`; the
  instruction is not. I14, I15 and the unhealthy half of I18 are untested.
- **I3 is asserted with a dust allowance of n base units.** KNOWN-LIMITS L6
  keeps dust in the vault, so the assertion is a band and not an equality.
- Nothing tests the permanent delegate seizing from a vault (L7), a transfer
  hook being set, a mint being paused, or the default account state flipping.
- No test runs against a cluster. bankrun only.
- The compute figures are from bankrun, not from a validator: first join 100,351
  CU, later joins 48k-60k, `quote_valuation` 4,792. NFR-3 wants n = 8 inside
  200k, and the n = 8 walk passes, but measured in the harness.

## 7. Open items, already recorded. Do not re-report unless the statement is wrong

From `OPEN-QUESTIONS.md`:

- `init_price_feed` has no authority gate: the first caller becomes the oracle
  for that mint. **BLOCKING before T23**, and it stands.
- The real xStocks carry `TransferHook` (program id unset), `Pausable`
  (unpaused), `DefaultAccountState` (thawed), `PermanentDelegate` and
  `ConfidentialTransferMint`. A plain `transfer_checked` is correct only while
  those three values hold, and all three are the issuer's to change.
- bankrun's bundled Token-2022 cannot parse those mints; resolved in the harness.
- **I4 cannot hold as a literal equality** now the vault is an ATA, because
  anyone can transfer in. Measured: 12,345 units in, then a join of 110,000,000,
  vault reads 110,012,345 against a member sum of 110,000,000. A wording fix in
  INVARIANTS.md, which the build does not own.
- **`create_circle` allowlists `stock_mint` but not `usdc_mint`.** A Token-2022
  "USDC" with `TransferFeeConfig` would have join credit `reserve_total += g`
  while the vault receives `g - fee`. Admin-only and unwritten today; the check
  belongs in T14.
- **KNOWN-LIMITS L4 names two routes to a stuck Active circle and there is a
  third.** A stale feed is neither a default nor a price fall: `release_pot` and
  `update_coverage` refuse for ever while `contribute` keeps accepting money,
  because SPEC.md:105 deliberately gives `contribute` no price check.
- SPEC §5's parameter ranges have floors and no ceilings. The build added the
  representability bounds; whether there should be a human maximum round length
  is the design session's.

## 8. Out of scope

- T14 to T16, unwritten: `init_pool`/`seed_pool`, `declare_default`,
  `top_up_reserve`, `add_stock`. The default waterfall does not exist.
- The frontend. It renders from fixtures and does not talk to the program.
- Deployment. Nothing has been deployed; T23 is Joshua's.
- `design/`, `SPEC.md`, `INVARIANTS.md`, `KNOWN-LIMITS.md` and `adr/` are the
  design session's. If one of them is wrong, say so and it is corrected there.

## 9. Output

A verdict line, exactly one of:

```
VERDICT: implementation-ready
VERDICT: changes required
```

Then findings as CRITICAL / MAJOR / MINOR, each with file and line, what breaks,
and the input or sequence that breaks it. Classify each INSIDE or OUTSIDE the
concerns stated above (U7), and name what you could not check (U8).

If a finding is a disagreement with the SPEC rather than with the code, say so.
