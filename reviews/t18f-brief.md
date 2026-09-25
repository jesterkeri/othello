# T18f review brief (T18d round 3): r2's fixes, and the Assets, stock and Portfolio pages

Codex T18d r2 (reviews/t18d-review.md, on T18e `0f0b2b6`) found: MAJOR, Paused disabled Release
(SPEC.md:129); MAJOR, Portfolio rounded u64 balances through Number and called the pre-multiplier
amount "raw"; MINOR, "anyone can release a pot" with no condition. All three are fixed here. This
branch also installs the Claude Design Assets list (with a List/Grid switch), the stock page, a
palette builder on every page, and renames the nav item Stocks to Assets.

## Review target

| | |
|---|---|
| branch | `task/T18f-assets-design` (from `task/T18e-circle-design`) |
| commit | `1efc57e` |
| range | `0f0b2b6..1efc57e` (r2's target, to this commit): 20 files, +1,328 / −274 |

`ef79981` and `6a0f537` in the range add only the r2 brief and verdict. Commits after `1efc57e`
change only this file. Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9.

## 1. The requirement

Everything in reviews/t18d-brief.md §1 and reviews/t18e-brief.md §1 still holds, with r2's
correction: Release pot is NEVER disabled on Paused (SPEC.md:129); Paused is stated as of the last
check. In addition:

- /assets and /assets/<symbol> (all 22 in lib/xstocks.ts): every figure from the mainnet mint read,
  Jupiter or GeckoTerminal; a failed read says so and shows no figure; unpriced stocks never rank as
  zero; the grid's liquidity bar is labelled relative; real mainnet stocks are "accepted as cover in
  Othello's mainnet build", never lockable in a live circle today; Buy stays a Jupiter quote handed
  off to Jupiter's own page (Othello builds no swap and holds no funds).
- Portfolio shows u64 balances exactly (no JS Number), labels the pre-multiplier amount as tokens
  "before ×", and states the release conditions.
- The palette builder saves a profile every page then offers.

## 2. What changed

| where | what |
|---|---|
| `components/live/LiveCircle.tsx` | Release not disabled on Paused; copy states the last check; a never-priced feed blocks release/update/declare |
| `components/portfolio/Portfolio.tsx`, `lib/format.ts` `shownTokens` | exact balances and demo tokens; "before ×"; conditional release copy |
| `components/assets/AssetsIndex.*`, `slots.ts` | Market board list, List/Grid switch (kept per browser, guarded storage), fixed colour per stock |
| `components/assets/AssetDetail.*`, `BuyPanel.tsx`, `PriceChart.tsx` | stock page: band, bento, issuer-powers dialog (in the markup when closed) |
| `components/othello/Shell.*`, `lib/nav.ts` | Assets nav item and icon; palette builder in the colours menu |
| tests | `t18e-paused-release-adversary` (bankrun: a Paused circle whose release the program accepts), `app-live-guards` (paused enabled; unpriced feed), `app-portfolio-exact` (2^53 + 1, units, demo tokens, copy) |

## 3. Already attacked

Adversary pass 3 (`0f0b2b6`) proved the Paused defect, fixed here with its test. Adversary pass 4
on `1efc57e` runs while you review; a proven defect comes as r4. Headless Chromium: /assets (list
and grid), /assets/NFLXx, /assets/AAPLx at 1440/390/360 with no overflow or errors; the dialog
closes on Escape; a palette made on /assets appears on /portfolio.

## 4. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-t18f
git branch --show-current   # must print task/T18f-assets-design; do not check out anything else
corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
git diff --check 0f0b2b6..1efc57e
./scripts/check-secrets.sh
```

`target/` is already built here; do not run `anchor build`. Read-only requests to devnet, mainnet,
Jupiter and GeckoTerminal are fine, sparingly. Never send a transaction, never run the ops scripts,
never read a keypair, any .env* file, ~/.config/solana or ~/.config/othello-demo.

## 5. Thin, stated rather than discovered

- The chart stays per raw token (a per-shown-token history needs the multiplier in force each day).
- Page layout is checked by headless Chromium, not component tests; Portfolio's connected state by
  server-render tests, not a wallet.
- The palette builder is Landing's, moved; it is not unit-tested.

## 6. Output

Replace `reviews/t18d-review.md` (round 3; the gate reads that file). FIRST line exactly
`VERDICT: implementation-ready` or `VERDICT: changes required`; then findings with severity
(BLOCKER / MAJOR / MINOR), INSIDE or OUTSIDE, file:line and a concrete failure scenario; U7; U8;
and the verification commands with their real output.
