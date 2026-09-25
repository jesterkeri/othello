# S2 review brief: the devnet stand-in mints and the devnet build

Gates 1 to 3 are implementation-ready: the program is complete for the
hackathon. S2 is what lets it run on devnet, where the real xStocks do not
exist (ADR-012). It is the last change before Joshua's devnet deploy (T23),
so it is the last thing between the reviewed program and the one judges see.

## Review target

| | |
|---|---|
| branch | `task/S2-devnet-mints` (draft PR #13, base `task/T16-topup`) |
| commit | `b62565b` |
| range | `aa25aca..b62565b` (gate 3's final head, implementation-ready, to this commit) |
| size | 15 files changed, 1,004 insertions(+), 6 deletions(-) |
| spec files, each in its own process | 24 files, 159 passing, 0 failing |
| `cargo test -p othello` | 57 passed; with `--features devnet`, 56 passed |

The branch head may be ONE commit later than `b62565b`; that commit adds only
this file.

Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`,
U1 to U9.

## 1. What S2 must do (the requirement)

- TASKS S2: "Token-2022 mints with ScaledUiAmountConfig, a labelled devnet
  allowlist entry that cannot coexist with the mainnet one (ADR-012). Done
  when: the mirror set is refused on the mainnet allowlist and accepted on the
  devnet one, and the label is asserted by a test."
- Joshua, 2026-09-25: addresses derived from the admin's public key with
  createWithSeed; NFLXx mirror only; the devnet USDC is "a classic SPL Token
  mint, not Token-2022, so it satisfies the pool's USDC guard ... Keep its mint
  address in the devnet-only allowlist/configuration; it must never be
  presented as real USDC." Circle's USDC replaces it after submission.
- The default (mainnet) build must behave exactly as gate 3 left it.

## 2. What changed

| file | what |
|---|---|
| `programs/othello/src/devnet.rs` | admin, mirror and test-USDC addresses; a unit test re-derives both with `Pubkey::create_with_seed` |
| `programs/othello/src/allowlist.rs` | `ALLOWED_STOCK_MINTS` is cfg-switched: the four mainnet mints by default, `[NFLXX_MIRROR]` under `devnet` |
| `programs/othello/src/instructions/pool.rs` | under `devnet` only, `init_pool` requires `usdc_mint == TEST_USDC` (MintNotAllowed) |
| `programs/othello/Cargo.toml` | the `devnet` feature |
| `ops/devnet-mints.ts` | hand-built Token-2022 / SPL / ATA instructions (no new dependency) and `standInState` |
| `ops/create-devnet-mints.ts` | Joshua's script: `--print` (reads no key) and `--create` |
| `ops/devnet-mints.json` | the recorded addresses and their display labels |
| `tests/harness.ts` | `harness()` and `upgradeableProgram()` take an optional ELF path |
| `tests/s2-*.spec.ts` | 15 tests; `s2-devnet-build` compiles the devnet binary into `target/devnet/` and runs it |

No error codes or events were added.

## 3. Decisions to check hardest

**USDC is pinned once, at init_pool.** Every circle takes its USDC mint from
its pool's seeds, and only init_pool creates a pool, so pinning init_pool pins
USDC for the whole devnet deploy. Check that no instruction lets a circle or
a member bring a USDC mint that did not come through a pool.

**The allowlist is swapped, not extended.** A devnet build accepts only the
mirror; a mainnet build never accepts it. A build that accepted both lists
could let a devnet mint stand in for a real one.

**Mint accounts are created as transfer + allocateWithSeed + assignWithSeed**,
not createAccountWithSeed (the adversary's defect, section 5). The claim is
that only the admin can give the account data or an owner, because both
`WithSeed` instructions require the base's signature, so a stranger's lamports
can only end up as part of the mint's rent.

**The instruction bytes are built by hand.** Each builder runs against the
real Token-2022 (`tests/fixtures/spl_token_2022.so`) and SPL Token programs in
bankrun and its account data is read back byte by byte.

## 4. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-s2
git checkout b62565b
anchor build
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
cargo test -p othello
cargo test -p othello --features devnet
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features devnet -- -D warnings
cargo fmt --check
pnpm exec tsc --noEmit -p tsconfig.json
```

Spec files one per process (gate 3 brief, section 2: a single-process run can
stall in bankrun). Run each cargo command alone. `s2-devnet-build` runs
`cargo build-sbf --features devnet` itself, so its first run takes a minute.
Never run `--create`: it signs with a real wallet and sends to devnet.

## 5. What has already been attacked

One adversary pass, given the requirement and the diff, never the author's
reasoning.

- **ONE defect, fixed in `b62565b`:** anyone could send lamports to a
  published stand-in address, after which createAccountWithSeed failed
  "already in use" for good and the devnet build's pinned mints could never
  exist. `tests/s2-adversary.spec.ts` is the adversary's test, unchanged except
  for one non-null assertion; it failed before the fix and passes after.
- Its three suspicions were also taken: the script refuses a non-devnet RPC by
  genesis hash, tops the admin up to 20,000 test USDC rather than minting 20,000
  per run, and checks an existing mint's owner, size, initialised flag, decimals
  and mint authority (`standInState`, tested).
- Attacks that failed: a stranger creating an account at a derived address; a
  circle on another USDC in the devnet build (ConstraintSeeds); the real NFLXx
  in the devnet build (MintNotAllowed); a Token-2022 USDC; the other USDC paths
  (has_one or pool seeds); the stand-ins in the default build; every hand-built
  instruction against the real programs; the spec passing for the wrong reason;
  the wrong wallet.

Mutations: disabling the devnet USDC pin fails 1 test; letting the devnet
allowlist also admit the real NFLXx fails 2.

## 6. Where the tests are thin, stated rather than discovered

- `ops/create-devnet-mints.ts --create` has not run end to end: it needs
  Joshua's wallet and devnet. Its pieces (`createNflxxMirrorIxs`,
  `createTestUsdcIxs`, `standInState`, the ATA and MintToChecked builders) are
  each tested in bankrun; the network wrapper (genesis check, send, confirm)
  is not.
- The devnet build is exercised through init_price_feed and init_pool. The
  rest of the instruction surface is the same code as the default build, which
  gate 3 reviewed; the adversary ran create_circle and join_and_lock against the
  devnet binary in a scratch file that was not kept.

## 7. Open items, already recorded. Do not re-report unless the statement is wrong

OPEN-QUESTIONS.md: the deploy costs more than AGENTS.md's "2.5 SOL budget"
(measured 4.24 SOL with PREFLIGHT's 1.2x max-len; funded); the deploy must use
the one program keypair that matches `declare_id`; the DEFAULT build does not
pin USDC (admin-only init_pool; pin Circle's mainnet USDC before any mainnet
deploy). TASKS.md: CIRCLE_USDC, S2b, ROTATE_AUTHORITY.

## 8. Out of scope

Gates 1 to 3 (reviewed); T24's seed script and T23's deploy (next); the
frontend.

## 9. Output

Write `reviews/s2-review.md`. Its FIRST line is exactly one of
`VERDICT: implementation-ready` or `VERDICT: changes required`;
`scripts/check-reviews.sh` reads that line. Then findings with severity
(BLOCKER / MAJOR / MINOR), INSIDE or OUTSIDE, file:line and a concrete failure
scenario; U7; U8; and the verification commands with their real output.
