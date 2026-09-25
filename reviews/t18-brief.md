# T24 + T18/S2b + T25 review brief: the live demo

S2 made a devnet build of the reviewed program (Codex S2 r1, implementation-ready at `b62565b`).
Since then it has been deployed (T23, byte-identical to that review) and seeded (T24), and the app
now shows it: the demo circle live from devnet, the four real xStocks live from mainnet, and a
member paying the round from their own wallet (T18, S2b). T25 adds the scripts the demo video
runs. This is the last review before the video and the submission.

## Review target

| | |
|---|---|
| branch | `task/T18-live-circle` (draft PR #14, base `task/S2-devnet-mints`) |
| commit | `87f1dfe` |
| range A: T23/T24, program line | `b62565b..3da8b1c`: 14 files, +1,347 / −4 (on `task/S2-devnet-mints`, merged here) |
| range B: the app | `46614fc..87f1dfe -- app ':!app/pnpm-lock.yaml'`: 16 files, +5,908 / −22 (4,909 of them the copied IDL) |
| range C: T25 and the app tests | `3da8b1c..87f1dfe -- ops tests`: 9 files, +816 |
| spec files, each in its own process | 31 files, 187 passing, 0 failing |
| `cargo test -p othello` | 57 passed; `--features devnet` 56 passed |

`fd470c7` merges `task/S2-devnet-mints` into the frontend line; its only conflict was DONE.md
(both sides appended; both kept). `46614fc` is the frontend line's head before this work
(wallet connect, S7); the frontend before it is out of scope. The branch head may be ONE commit
later than `87f1dfe`; that commit adds only this file.

Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9.

## 1. What it must do (the requirement)

- TASKS T24: `ops/seed-demo-circle.ts` with SPEC §5's demo parameters; circle address recorded;
  all five joined before the split. SPEC.md:137 gives every parameter, H = 132, and the split.
- TASKS T18: the frontend reads the live devnet circle.
- TASKS S2b (Joshua): "the app ALSO reads the real NFLXx mint from mainnet, read-only, and shows its
  multiplier and scheduled change next to the mirror's, each clearly labelled ... with a clear error
  (never a stale or made-up number) when the mainnet read fails". Scope: the four verified xStocks.
- Joshua's demo decision: five script-held members; he imports seat 2's key into Phantom and pays
  one round on camera from the app. Scripts play the other seats and release the pots.
- Standing rules: real data or a clear error; test USDC never presented as real USDC; the mirror
  always labelled; the app never holds a key; nothing secret in client output (PREFLIGHT).

## 2. What changed

| where | what |
|---|---|
| `ops/demo.ts` | the demo circle (SPEC.md:137) and every step: seed, split, payRound, releasePot, over a `Chain` interface |
| `ops/devnet-cli.ts` | devnet `Chain`: genesis-hash check, admin = recorded wallet = program's upgrade authority; member keys outside the repo (0700/0600); `loadDemoMembers` loads only |
| `ops/seed-demo-circle.ts`, `schedule-split.ts`, `play-round.ts`, `export-member-key.ts`, `verify-*.ts` | the CLIs Joshua runs; export prints one secret and refuses a non-TTY stdout |
| `ops/demo-circle.json` | the seeded circle's public addresses |
| `app/src/lib/live.ts` | reads circle, feed, mint, members; decodes with the deployed IDL into the existing `CircleView` |
| `app/src/lib/scaledUi.ts` | Token-2022 ScaledUiAmount TLV reader; `toFixed1e9` a bit-exact port of `decode_multiplier_fixed` |
| `app/src/lib/contribute.ts` | builds `contribute` from the IDL; names program refusals from the IDL |
| `app/src/app/api/circle`, `api/live` | server reads (devnet circle cached 4 s; four mainnet mints cached 60 s); errors in their own words only |
| `app/src/components/live/*`, `circle/Circle.tsx` | `/circle/demo` live; Circle gains a `live` mode; fixture screens unchanged but for two display fixes |
| `app/next.config.mjs`, `.vercelignore` | app/ is its own tracing root (Vercel); env files never upload |
| dependency | `@coral-xyz/anchor` 0.32.1 in app/ (Joshua approved); two `toml` advisories, not in the browser bundle (OPEN-QUESTIONS) |

## 3. Decisions to check hardest

**One code path for devnet and the tests.** Every seed and round step is written once against
`Chain`; the specs run the same functions on `target/devnet/othello.so` in bankrun. Check that
the devnet `Chain` (`devnet-cli.ts`) cannot behave differently from the bankrun one in a way that
matters (confirmation, preflight, clock).

**Idempotency.** Each step reads the chain before acting: a finished seed sends nothing, a run
stopped half way finishes on re-run (it did, on devnet), the pool and prices are seeded only
before the circle exists, a split only once the circle is Active.

**The app labels, the chain decides.** `decodeLive` maps chain accounts onto the fixtures' shape;
`toFixed1e9` must land on the program's integer (the T18 adversary proved Math.round did not).
Check any other place the app could show a number the program would not.

**Server reads.** Both routes answer 502 with their own words on failure (a malformed keyed URL
once reached the browser through fetch's message; fixed, sentinel-checked). Check caching, error
pass-through (`/api/circle`'s regex) and staleness.

**Keys.** The app holds none. The demo member keys are devnet-only, outside the repo, created only
by the seed; `export-member-key.ts` refuses a non-TTY stdout and any key that is not the recorded
member of that seat.

## 4. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-t18
git checkout 87f1dfe
corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
anchor build
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
cargo test -p othello
cargo test -p othello --features devnet
cargo clippy --all-targets -- -D warnings
cargo fmt --check
pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
```

One spec file per process (a single-process run can stall in bankrun; gate 3 brief §2). Several
specs run `cargo build-sbf --features devnet` themselves on first use. Read-only RPC reads are
fine; never run the ops scripts against devnet, never send a transaction, never read a keypair,
`.env*`, `~/.config/solana` or `~/.config/othello-demo`.

## 5. Already attacked

Five adversary passes, each given the requirement and the diff, never the reasoning:

- **T24:** two defects, fixed in `a1224f6`: a split scheduled mid-seed wedged the seed for good;
  a re-run refilled the pool after a demo default. `tests/t24-adversary.spec.ts`.
- **T18:** one defect, fixed in `b848d11`: Math.round instead of the program's floor put AAPLx one
  unit high and showed a false Repricing. Also taken: stale xStock numbers after a failed read; a
  keyed URL in a 502 body; the account-type byte. `tests/t18-adversary.spec.ts`.
- **T25 + T18 fixes:** two defects, fixed in `0265f83`: export-member-key made up and saved keys on
  a machine without them; toFixed1e9 refused multipliers the program accepts. `tests/t25-adversary.spec.ts`.
- **0265f83:** no defect in 10 attacks (toFixed1e9 against an independent reference on 630,020 bit
  patterns, 0 mismatches).

Every fix was mutation-checked (DONE.md has each line).

## 6. Where it is thin, stated rather than discovered

- A real wallet signing Contribute in a browser has not run; the instruction is proven in bankrun
  on the devnet build, and the UI flow is Joshua's first check with seat 2's key in Phantom.
- No React renderer in the repo: the live screen is checked by headless Chromium screenshots at
  1280 and 390 px (no console errors, no horizontal overflow), not by component tests.
- `releasePot` pre-checks only unpaid seats, not escrow for defaulted seats, freshness or the gate;
  in those cases preflight simulation refuses the transaction without a fee.
- Which multiplier is "in force" in the app is chosen by the server's clock, not the chain's.
- A feed priced for a multiplier above ~9 million x would make decodeLive throw (bn.js toNumber)
  and the route would say "devnet RPC unreachable"; unrealistic, noted.
- No test imports the Next route handlers; they are checked by `next start` and `vercel curl`.

## 7. Open items, already recorded. Do not re-report unless the statement is wrong

OPEN-QUESTIONS: deploy cost vs the old 2.5 SOL budget; the one program keypair; the default
(mainnet) build does not pin USDC; the two `toml` advisories. TASKS: CIRCLE_USDC, ROTATE_AUTHORITY.
DONE.md records that my first `vercel deploy` targeted production by the platform's default and
failed at build, so no production deployment exists.

## 8. Out of scope

Gates 1 to 3 and S2 (reviewed); the frontend line up to `46614fc` (wallet connect, fixtures);
production hosting and the submission (Joshua).

## 9. Output

Write `reviews/t18-review.md`. Its FIRST line is exactly one of
`VERDICT: implementation-ready` or `VERDICT: changes required`; `scripts/check-reviews.sh` reads
that line. Then findings with severity (BLOCKER / MAJOR / MINOR), INSIDE or OUTSIDE, file:line and
a concrete failure scenario; U7; U8; and the verification commands with their real output.
