# T18e review brief (T18d r2): the button guards, and the Claude Design pages

Codex T18d r1 (reviews/t18d-review.md, `changes required`) found one MAJOR: the live circle's
release / update / default buttons were enabled on seat bits and time alone, although the read
already knew conditions the program refuses on (stale price, repricing, Paused, pool liquidity).
This branch fixes that, folds in adversary pass 2's two false statements, and installs Claude
Design's Circle and Portfolio pages (Joshua: "some of the UI look better from what Claude Design did").

## Review target

| | |
|---|---|
| branch | `task/T18e-circle-design` (from `task/T18d-shell`) |
| commit | `0f0b2b6` |
| range | `d0afc33..0f0b2b6` (T18d r1's target, to this commit): 16 files, +1,453 / −302 |
| spec files, each in its own process | 42 files, 248 passing, 0 failing (at `de518c2`; `0f0b2b6` reruns below) |

`0c953d1` and `206daf0` in the range add only the r1 brief and verdict. Commits after `0f0b2b6`
change only this file. Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9.

## 1. The requirement

Everything in reviews/t18d-brief.md §1 still holds. In particular, the r1 finding:

- On /circle/demo a button is enabled only when every condition the live read knows holds
  (SPEC §5): release_pot needs every seat paid or defaulted, a fresh price, not repricing, not
  Paused (next_gate_short_by == 0); update_coverage needs Active, fresh, not repricing;
  declare_default needs strictly after deadline + grace, seat unpaid, received, not defaulted, a
  fresh price, and pool USDC >= recovered (SPEC §6). Each disabled state says why; no copy claims
  an action is available when the program would refuse it.
- Portfolio: mainnet and devnet never mixed in one card or total; a dollar total only when every
  holding is priced; the 24h move only from Jupiter's change24h; a failed read says so.

## 2. What changed

| where | what |
|---|---|
| `lib/circle.ts` `defaultRecovered` | SPEC §6 `recovered`, ported with declare_default.rs `waterfall`'s rounding |
| `lib/live.ts` | the live read also returns the pool's `discountBps` and USDC vault balance |
| `components/live/LiveCircle.tsx` | guards from `derive()` (stale, repricing, paused) and the pool; reasons in the panel; adversary pass 2 fixes (a defaulted seat is "covered by the default", not "paid"; a sent-then-refused transaction shows its signature, not "not sent"; the caller's rent stated) |
| `components/circle/Circle.tsx`, `Circle.module.css` | Circle.dc.html: acid "this round" card with the action box, turn tiles, reserve ledger, cover steps, member tickets led by each owner's stake; banner no longer promises a release the gate would refuse |
| `components/live/XStocksPanel.tsx` | "Stocks a circle can accept as cover", a reference list (real, mainnet, read only), rows as links with the design's hover |
| `components/portfolio/*` | Portfolio.dc.html: total card (mainnet), circle card (devnet), holdings rows, demo tokens |
| `components/othello/Shell.*` | the rail's flag tag on hover/focus |
| tests | `app-live-guards` (8 states, every guard mutation-checked), `app-actions` (defaultRecovered equals the pool's real payout in bankrun), `t18d-anyone-actions-adversary`; `app-portfolio-adversary` now reads the total card (assertions unchanged; the $0-total mutation still fails it) |

## 3. Already attacked

Adversary pass 2 on `d0afc33`: two false statements, fixed here with its test. Adversary pass 3
on `0f0b2b6` runs while you review; a proven defect comes as r3. Headless Chromium: no page
overflow or lost content at 360/390 except Landing's decorative ticker; rail tag, row hover and
Portfolio connect card screenshotted.

## 4. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-t18e
git branch --show-current   # must print task/T18e-circle-design; do not check out anything else
corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
git diff --check d0afc33..0f0b2b6
./scripts/check-secrets.sh
```

`target/` is already built in this worktree (copied from the T18d build); `anchor build` is not
needed. `./scripts/check-reviews.sh` fails until this review's verdict replaces r1's in reviews/t18d-review.md. Read-only
requests to devnet, mainnet and Jupiter are fine, sparingly. Never send a transaction, never run
the ops scripts, never read a keypair, any .env* file, ~/.config/solana or ~/.config/othello-demo.

## 5. Thin, stated rather than discovered

- The pool balance is as of the last read (5 s refresh); the program re-checks at send.
- The browser clock decides when "Declare" appears; clock skew shows as GraceNotElapsed.
- Portfolio's connected state is covered by server-render tests, not a browser with a wallet.

## 6. Output

Replace `reviews/t18d-review.md` (this is its round 2; the gate reads that file). FIRST line exactly `VERDICT: implementation-ready` or
`VERDICT: changes required`; then findings with severity (BLOCKER / MAJOR / MINOR), INSIDE or
OUTSIDE, file:line and a concrete failure scenario; U7; U8; and the verification commands with
their real output.
