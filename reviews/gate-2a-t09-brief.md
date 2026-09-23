# Gate 2a review brief: T09, the first instruction that moves money

> NOT RUN. Joshua, 2026-09-23: "if its at gate boundaries then keep building,
> when u get there just bundle up." Codex stays at the gate boundary, so this
> was written early and is not a pending request. It is kept as raw material:
> sections 2, 4, 6 and 7 fold into T13's gate 2 brief, where the same three
> structural decisions will be reviewed alongside the payout gate they carry.

This was written as an **early, partial** review, pulled forward from T13. Gate 2
is T08 through T12 and its full brief is still T13. T09 is being put in front of
you now because it fixes the shape every later instruction inherits, and three
of those decisions are cheap to change today and expensive at T13.

Commit under review: `abb2829` on `task/T09-join-and-lock`, branched from
`staging`. Diff range `origin/staging..task/T09-join-and-lock`, two commits.

Review under `orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9.

## 1. What T09 had to do

SPEC.md §5, three rows:

- `join_and_lock(stock_raw)`: signer found by scanning `members[..n]` (turn =
  index; no turn argument); creates the member's USDC ATA if missing, member
  pays. Preconditions: Forming, not joined, `H(stock_raw) >= min_stock_cover`,
  price fresh and not repricing. Effect: stock to vault, guarantee to vault,
  `reserve_total += g`, `deposits_total += g`. Refusals: `not_a_member`,
  `circle_not_forming`, `collateral_below_minimum`, `insufficient_balance`,
  `price_stale`, `multiplier_price_mismatch`, `multiplier_invalid`.
- `cancel_circle`: creator, Forming only, status Cancelled, refunds via
  `withdraw`. Refusal: `circle_not_forming`.
- `activate`: creator, Forming, `joined_bitmap` full. Effect: Active, round 0,
  `round_deadline = now + round_secs`. Refusal: `not_all_joined`.

Plus INVARIANTS.md I4, and SPEC.md §4's `Member` layout.

## 2. The three decisions worth your attention

These are why this is not waiting for T13.

**The circle's vaults are Associated Token Accounts, not program-derived token
accounts.** T08 tried Anchor's `init`, which allocates a token account's base
165 bytes. A real xStock refuses that: a Token-2022 account for an
extension-carrying mint needs more, and `InitializeAccount3` returned
`InvalidAccountData`. Using ATAs moves the sizing to the program that computes
it. The consequence is that the vault address is derived from (mint, authority)
rather than from a seed this program chose, and **anyone can transfer into it**.

**`anchor-lang` now carries the `init-if-needed` feature.** Used on three
accounts: the circle's two vaults and the member's USDC ATA. No Othello state
account uses it; the `Member` PDA uses plain `init`.

**The seat is found by scanning `circle.members` and is never an argument.**
`join_and_lock.rs:130`.

## 3. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello
git checkout task/T09-join-and-lock
anchor build
anchor test          # 54 passing
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`tests/fixtures/spl_token_2022.so` is the real Token-2022, dumped from devnet
with `solana program dump`. The harness loads it because bankrun 0.4.0's own
Token-2022 predates extensions 25 (`ScaledUiAmountConfig`) and 26 (`Pausable`)
and returns `InvalidAccountData` for the real mints. Without that file none of
the token movement tests can run.

## 4. What to review

- `programs/othello/src/instructions/join_and_lock.rs`
- `programs/othello/src/instructions/lifecycle.rs`
- `programs/othello/src/state.rs`, the `Member` account
- `programs/othello/src/errors.rs`, `events.rs`, `lib.rs`, `instructions.rs`
- `programs/othello/Cargo.toml`, the feature change
- `tests/t09-join-and-lock.spec.ts`, `tests/t09-adversary.spec.ts`,
  `tests/harness.ts`

Specific questions this build cannot answer about itself:

1. Are the ATA constraints sufficient to pin every token account to the right
   mint, authority and token program, in every combination? The stock is
   Token-2022 and the USDC is SPL Token, so there are two token programs in one
   instruction.
2. Is `init_if_needed` safe on all three uses, including the member-paid USDC
   ATA, where the payer and the authority are the same untrusted wallet?
3. `join_and_lock` reads the mint's data directly via `try_borrow_data` while
   the same mint is also an `InterfaceAccount<Mint>` in the same context. Is
   that borrow sound under every path, including the CPI that follows?
4. Ordering: is there any sequence of `join_and_lock`, `cancel_circle` and
   `activate`, across or within transactions, that leaves `reserve_total`,
   `deposits_total`, `joined_bitmap` and the vault disagreeing?
5. `activate`'s full-bitmap arithmetic branches on `n >= 8` to avoid
   `1u8 << 8`. Is the branch right for every n in 3..=8?

## 5. What has already been attacked, and found nothing

An adversarial pass ran 23 attacks against this diff with the spec and without
the reasoning behind the code, and broke none: seat and authority (6), account
substitution (6), price and time against I13 (4), accounting, ordering and
arithmetic (7). It is not a substitute for this review; it is what has already
been swept so you can spend the time elsewhere. Its five tests are integrated
and passing.

Do not re-report these, they are fixed in `abb2829`: an unreachable
`AlreadyJoined` guard whose comment claimed the opposite, a dead
`vaultAddress()` helper in the harness, and a false coverage claim in `DONE.md`.

## 6. Where the tests are thin, stated rather than discovered

- `multiplier_invalid` has no test. It is unreachable through an allowlisted
  mint, because all four fixtures decode. Stated, not covered.
- Nothing tests the permanent delegate actually seizing from a vault. It is
  KNOWN-LIMITS L7 and not preventable in-program.
- No test covers a transfer hook being set, a mint being paused, or the default
  account state flipping. All three are the issuer's to change and all three are
  currently in the benign state; see §7.
- Clock rollback behind `updated_at` is accepted by the freshness rule as
  SPEC.md:140 literally states it. Already recorded in OPEN-QUESTIONS.

## 7. Open items, already recorded. Do not re-report unless the statement is wrong

From `OPEN-QUESTIONS.md`, all added by this work:

- The real xStocks carry `TransferHook`, `Pausable`, `DefaultAccountState`,
  `PermanentDelegate` and `ConfidentialTransferMint` as well as
  `ScaledUiAmountConfig`. None blocks Othello today, and only because the hook
  program id is all zeroes, `paused` is 0 and the default account state is
  thawed. A plain `transfer_checked` is correct only while that holds. Mainnet
  question, KNOWN-LIMITS L7.
- bankrun's bundled Token-2022 cannot parse those mints; resolved in the harness
  by loading the real program.
- I4 reads as a literal equality and cannot be one now the vault is an ATA.
  Measured: 12,345 raw units transferred in, then a join of 110,000,000, vault
  110,012,345 against a member sum of 110,000,000. INVARIANTS.md is the design
  session's file, so this is recorded as a wording fix, not edited.
- `create_circle` allowlists `stock_mint` but not `usdc_mint`. A Token-2022
  "USDC" carrying `TransferFeeConfig` would have join credit
  `reserve_total += g` while the vault receives `g - fee`. Admin-only and
  unwritten today; the check belongs in T14.

## 8. Out of scope for this review

- T10 to T12, unwritten: `contribute`, `release_pot`, `update_coverage`,
  `withdraw`. The payout gate is not implemented and is not here to review.
- The frontend, which does not talk to the program at all.
- Deployment. Nothing has been deployed; T23 is Joshua's.
- The `init_price_feed` oracle-takeover item, which stands until T23 and is
  recorded in OPEN-QUESTIONS.

## 9. Output

A verdict line, exactly one of:

```
VERDICT: implementation-ready
VERDICT: changes required
```

Then findings as CRITICAL / MAJOR / MINOR, each with a file and line, what
breaks, and the input or sequence that breaks it. If a finding is a disagreement
with the SPEC rather than with the code, say so: the SPEC is the design
session's and is corrected there, not here.
