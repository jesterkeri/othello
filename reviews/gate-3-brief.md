# Gate 3 review brief: defaults, and the circle that survives them

Gate 2 built a circle that takes money and pays it out while everyone pays.
Gate 3 is what happens when someone does not. A member who has already
received the pot stops paying; their collateral has to stand behind what they
still owe, so nobody later in the order is left short. It also closes the one
BLOCKING-before-deploy finding the earlier gates recorded: the price feed's
authority could be taken by whoever called `init_price_feed` first.

This is the last program review before the demo is deployed.

## Review target

This block is the SOURCE OF TRUTH for every figure that changes between review
rounds. Nothing below restates a figure from it; section 3 gives the
per-instruction BREAKDOWN of the `init_if_needed` total, recounted from source
together with this block, and where they disagree this block wins.

| | |
|---|---|
| branch | `task/T16-topup` |
| commit | STAMP, the code and design pack under review |
| range | `3028b3f..STAMP` (gate 2's reviewed head to this commit) |
| size | STAMP |
| spec files, each in its own process | STAMP |
| `cargo test -p othello` | STAMP |
| `init_if_needed` uses | STAMP, itemised per instruction in section 3 |

Every figure above was produced by running the command at the named commit,
not carried forward. The branch head may be ONE commit later than the commit
named here; that commit changes only this block, which cannot name its own
hash.

Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`,
U1 to U9.

## 1. What is in scope

The range above, which is gate 3 alone. Gate 2 is reviewed separately on
`task/T09-join-and-lock` and its r4/r5 fixes were merged into this branch
(the merge commit `d7cc816`); they are context here, not scope.

| task | what | files |
|---|---|---|
| T14 | admin root; `init_pool`, `seed_pool` | `instructions/pool.rs`, `instructions/price_feed.rs` (InitPriceFeed accounts only), `tests/harness.ts` |
| T15 | `declare_default` and the SPEC §6 waterfall | `instructions/declare_default.rs`; `update_coverage.rs`'s recompute extracted into `load_members` + `recompute_coverage` |
| T16 | `top_up_reserve`, `add_stock` | `instructions/top_up_reserve.rs`, `instructions/add_stock.rs` |
| R2+R3 | one refactor pass over gates 2 and 3 | `gate.rs`, `state.rs`, and small edits across instructions |
| pack | SPEC r6, r8; KNOWN-LIMITS r7 (via the merge) | `SPEC.md`, `INVARIANTS.md`, `ARCHITECTURE.md` |

Errors appended (codes are the client contract; `errors.rs` is append-only):
GraceNotElapsed, SeatAlreadyPaid, PrePayoutDefaultUnsupported, PoolInsufficient.
Events added: PoolInitialized, PoolSeeded, DefaultDeclared, ReserveToppedUp,
StockAdded.

## 2. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-t16
git checkout <commit in the Review target block>
anchor build
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
cargo test -p othello
cargo clippy --all-targets -- -D warnings
cargo fmt --check
pnpm exec tsc --noEmit -p tsconfig.json
```

**Run the spec files one per process, as above.** `anchor test` runs them all
in one process, and that intermittently stalls with no output at all (3 of
about 8 runs on 24 Sep; once for over an hour at ~650% CPU). It is recorded,
not root-caused, in OPEN-QUESTIONS.md "INTERMITTENT FULL-SUITE STALL": every
file passes alone every time, and the stall is not load-related (it also
happened at load 3.5). If `anchor test` completes for you, its count should
equal the sum of the per-file counts. Run cargo, clippy and fmt alone too:
two of them in one shell line fight over `target/`.

## 3. The decisions a reviewer should check hardest

**The admin is the program's upgrade authority.** `init_price_feed` and
`init_pool` require the signer to be `upgrade_authority_address` in the
upgradeable loader's ProgramData account for THIS program: `program` must be
Othello, `program.programdata_address()` must equal the `program_data` passed.
set_prices, touch_prices and seed_pool check the authority those two record.
Chosen over a config PDA because it needs no new account, no new key and no
setup transaction, so there is no window after deploy for anyone to claim a
feed. The harness had to change for this to be testable: startAnchor loads
programs through the old non-upgradeable loader, which has no ProgramData, so
`tests/harness.ts` re-places Othello as an upgradeable deploy leaves it
(`upgradeableProgram`). The T14 adversary checked that rewriting the
ProgramData authority byte changes who is admin, so the harness is not passing
tests for the wrong reason.
Rotation is decided and deferred: today a rotated-out key keeps the feed and
pool it created ((a)); `rotate_authority`, option (c), is tracked in TASKS.md
for before Colosseum or mainnet. (b), checking the live upgrade authority on
every admin call, was rejected: an immutable program could then never set a
price again.

**The USDC mint must be classic SPL Token.** `init_pool` pins
`usdc_token_program == spl_token::ID`. Circles take their USDC mint from the
pool's seeds, so this one check covers every circle, and SPL Token has no
extensions, so fee-on-transfer (which would make `reserve_total` larger than
the vault, breaking I3) is closed with the whole class.

**Pool vaults use `init_if_needed`.** Anyone can create an associated token
account for any owner; with `init`, one stranger's transaction would block
`init_pool` for that mint pair forever. The ATA constraints still pin mint,
owner and token program. Per instruction:

| instruction | `init_if_needed` |
|---|---|
| `join_and_lock` | 3 |
| `leave_forming` | 2 |
| `release_pot` | 1 |
| `withdraw` | 2 |
| `init_pool` | 2 |

**The waterfall is a pure function.** `declare_default::waterfall()` carries all
of SPEC §6's arithmetic and is unit-tested apart from any transaction. Two SPEC
edges are made explicit: a conservative price of zero sells NOTHING (ceil(O/0)
is undefined, and selling for zero would take stock for no money); and a mint
whose multiplier cannot be read takes the capped branch instead of refusing,
because the sale never needed it.

**"Exactly as update_coverage" is one function.** SPEC says declare_default's
normal branch recomputes exactly as update_coverage. That recompute was
extracted from update_coverage into `recompute_coverage` and both call it. The
one ordering difference: all Member accounts are now validated before any is
valued, rather than interleaved. update_coverage's T11 tests pass unchanged.

**The capped branch (Repricing).** Per SPEC r4: no H; the defaulter's
allocation 0 and `last_coverage_bps` the "Prepaid" sentinel; survivors keep
their allocations capped in turn order to R − L (now via the same
`allocate_in_turn_order`); `next_gate_short_by += deficit`; `last_coverage_at`
not stamped. SPEC r8 records that short_by is approximate here until the next
full refresh (I18's stated exception).

**A top-up fills the escrow deficit first**, then the reserve, and
`next_gate_short_by` moves in SPEC r4's closed form. SPEC r8, Joshua's decision
(a): a fill is a deposit, shared pro rata at settlement, not "not returned".

## 4. What to review

- SPEC §5 rows for init_pool/seed_pool, declare_default, top_up_reserve,
  add_stock, including their refusal lists (r8 completed them) and the ORDER
  in which each handler checks.
- SPEC §6 line by line against `waterfall()` and the handler's books.
- SPEC §7 withdraw with defaulters and top-ups present (I11, I15, I16).
- INVARIANTS: I2 (both recompute branches), I3, I4, I6, I7, I8, I9, I10, I13,
  I14 and I18 as worded in r8, I15.
- The R2+R3 refactor as a behaviour-preserving change: `Circle::
  reserve_remaining`, `gate::short_by`, `gate::checked_total`,
  `gate::COVERAGE_BPS_NOT_A_RATIO`, and the capped branch's use of
  `allocate_in_turn_order`. DONE.md lists the five proposals declined and why;
  one would have changed refusal order.

## 5. What has already been attacked

Three adversary passes, one per task, each given SPEC and the diff and never
the author's reasoning; their tests are integrated and pass on this branch.

- **T14:** no defect in 14 attacks (stranger admin; a stranger's own genuine
  ProgramData; another executable as `program`; a loader Buffer as ProgramData;
  immutable program; pre-funded or pre-created PDAs and vaults; Token-2022 USDC
  either way; second init_pool; seed from an account the admin is only
  delegate on; non-ATA pool account; another pair's pool).
  `tests/t14-adversary.spec.ts`.
- **T15:** ONE defect, fixed: the capped branch left a defaulted member's
  `last_coverage_bps` at 13000 instead of SPEC.md:70's "Prepaid" sentinel.
  11 other attacks failed. `tests/t15-adversary.spec.ts`.
- **T16:** no defect in 7 attacks, including a late top-up used to capture
  others' shares (it returns less than it put in and raises everyone else's
  share; pool_left ≤ denominator at Completed). `tests/t16-adversary.spec.ts`.

Mutation testing, every safety check removed in turn (DONE.md has each line):
T14 10 of 10 caught; T15 12 of 12 after one added test; T16 12 of 12 after one
added test; the refactor's two reworked sites, one caught first time and the
other after one added test. Three of those "added test" cases were real gaps the mutations exposed;
each is recorded.

## 6. Where the tests are thin, stated rather than discovered

- No stock mint with a TransferHook or TransferFee has been attacked: the
  allowlist admits only the four real mints, none of which carries either.
- Pre-payout default is refused (KNOWN-LIMITS L3), so there is no test of a
  member who stops paying before their turn beyond that refusal. A designed
  alternative is recorded for after the deadline (TASKS.md).
- I14 is exercised for one deficit shape (a price fall then one default). A
  deficit from two defaults at unchanged prices is not separately tested.
- The single-process suite stall (section 2) is not root-caused.

## 7. Open items, already recorded. Do not re-report unless the statement is wrong

In OPEN-QUESTIONS.md: admin rotation (decided, (c) deferred to TASKS);
capped-branch survivors keep an older `last_coverage_bps` (allowed by "as of
last recompute"); the intermittent suite stall; the deficit-fill copy and I14
and I18 wording (resolved by r8). KNOWN-LIMITS L3 (no pre-payout default) and
the coverage-based default cut (SPEC §6) stand.

## 8. Out of scope

Gate 2's own code (reviewed on its branch); the frontend branches; devnet
deployment and the seed script (T23, T24); matchmaking, solo mode and the
circle chat (after submission).

## 9. Output

Write `reviews/gate-3-review.md`. Its FIRST line is exactly one of
`VERDICT: implementation-ready` or `VERDICT: changes required`;
`scripts/check-reviews.sh` reads that line. Then findings with severity
(BLOCKER / MAJOR / MINOR), INSIDE or OUTSIDE, file:line and a concrete failure
scenario; U7; U8; and the verification commands with their real output.
