# T18c review brief: the judge's path

Joshua, on the day of submission: the app did not read as one end-to-end product. A click-order
audit found a 404 in the nav, seat pages showing a fixture circle, a live circle that looked
stalled, and a Create button with a false reason. This branch fixes that path, then adds what a
buy-and-lock product needs: a portfolio, a catalog of buyable stocks with charts, and Buy.

## Review target

| | |
|---|---|
| branch | `task/T18c-charts` (draft PR #15, base `task/T18-live-circle`) |
| commit | `b223a46` |
| range | `f95c4b4..b223a46` (the T18 r3 fix, to this commit): 38 files, +1,681 / −75 |
| spec files, each in its own process | 36 files, 203 passing, 0 failing |
| `cargo test -p othello` | 57 passed; `--features devnet` 56 passed |

Commits after `b223a46` change only this file. The base, `task/T18-live-circle` at `f95c4b4`, is
itself under Codex r4 (reviews/t18-review.md); that range is not in scope here.

Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9.

## 1. The requirement

- A judge can follow one story through the app with no dead ends, no contradictions and no false
  statements: every nav item leads to a real page; the demo circle's pages show the live circle.
- Real data or a clear error. No stale or made-up number anywhere; a failed read says so. Every
  price says what it is: GeckoTerminal's is per RAW token, Jupiter's per DISPLAYED token (raw times
  the mint's multiplier).
- Test USDC and the NFLXx devnet mirror are never presented as real USDC or the real NFLXx.
- Listed stocks are only Backed's (mint authority 7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj),
  verified on mainnet, not paused, and buyable (a Jupiter route). Only the program's four allowlisted
  mints are marked as accepted as cover.
- The app never holds a key and builds no swap: Buy quotes and hands off to Jupiter's own page for
  exactly that pair; Portfolio only reads.
- Server-only env (MAINNET_RPC_URL, DEVNET_RPC_URL) never reaches the browser, including through
  error bodies.
- Statements about the protocol are true per SPEC §5 (contribute has no time check; release_pot is
  sent by anyone; declare_default is anyone's, only for a seat that has received, strictly after
  deadline + grace), §6, and KNOWN-LIMITS L3, L7, L10.
- Portfolio was a SPEC cut (FRAME §4, "portfolio dashboard"); Joshua reinstated it today.

## 2. What changed

| where | what |
|---|---|
| `app/how-it-works`, `components/howitworks/*` | six-step story, live figures from /api/circle, links into the app |
| `lib/devnet.ts` DEMO_NAMES, `lib/live.ts` | the fixtures' cast (Ada..Nneka) as the demo circle's display names |
| `components/live/LiveSeat.tsx`, `Position.tsx`, `Join.tsx`, seat routes | /circle/demo/{position,join}/N read the live circle, in test USDC |
| `components/circle/Circle.tsx` | live round status: paid n of 5, late still counts, defaultable names only when true |
| `app/circle/new/page.tsx` | Create's refusal states its true reason |
| `app/api/holdings`, `components/portfolio/*`, `app/portfolio` | the wallet's seat, its xStocks (mainnet), its demo tokens |
| `lib/xstocks.ts` | 22 buyable xStocks, with provenance |
| `app/api/live` | reads all 22 plus Jupiter prices; an unreadable mint is named, not fatal |
| `app/api/chart`, `components/assets/PriceChart.tsx` | GeckoTerminal daily closes for the busiest USDC pool (by mint), one retry |
| `app/api/quote`, `components/assets/BuyPanel.tsx` | Jupiter quote; hand-off to jup.ag?sell=USDC&buy=<mint> |
| `components/assets/*`, nav (`lib/nav.ts`, Landing, Shell) | catalog with search, four pinned; Portfolio and How it works in the nav |

## 3. Already attacked

One adversary pass on `16748e1`: three findings, fixed in `b223a46` with its tests (integrated
unchanged): Portfolio showed "$0.00" when Jupiter's price failed; "can be declared in default" one
second early; "the pot is released as soon as everyone has paid" (false). Two suspicions also
taken (route errors, paused mints). DONE.md has the detail.

## 4. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-t18c
git checkout b223a46
corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
anchor build
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
git diff --check f95c4b4..b223a46
./scripts/check-secrets.sh
```

Read-only requests to mainnet, devnet, Jupiter and GeckoTerminal are fine, sparingly (they
rate-limit). Never send a transaction, never run the ops scripts against devnet, never read a
keypair, any .env* file, ~/.config/solana or ~/.config/othello-demo.

## 5. Thin, stated rather than discovered

- No React component tests beyond the adversary's server-render harness; pages are checked by
  headless Chromium (11 pages at 1280 and 390 px, no console errors or overflow).
- The registry is a snapshot (2026-09-25). /api/live re-reads each mint live and shows a pause, but
  does not re-check liquidity or Jupiter routability.
- GeckoTerminal's free API returns about six months of daily candles, so NFLXx's Nov 2025 split is
  outside its chart (the chart says so).
- Buy is a hand-off, not an in-app swap.

## 6. Output

Write `reviews/t18c-review.md`. FIRST line exactly `VERDICT: implementation-ready` or
`VERDICT: changes required`; then findings with severity (BLOCKER / MAJOR / MINOR), INSIDE or
OUTSIDE, file:line and a concrete failure scenario; U7; U8; and the verification commands with
their real output.
