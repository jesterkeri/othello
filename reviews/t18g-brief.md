# T18g review brief (T18d round 4): r3's fixes, member actions, and Buy in place

Codex T18d r3 (reviews/t18d-review.md, on T18f `1efc57e`): BLOCKER, `shownTokens` rounded the
multiplier; MINOR, Buy's "Raw" row went through Number; MINOR, the issuer-powers count omitted an
enabled transfer hook with no program. All three are fixed here. Joshua then asked for what was left:
collateral wording, how Othello earns, search in the top bar, a member's own actions, and Buy done
entirely on the site. All five are here.

## Review target

| | |
|---|---|
| branch | `task/T18g-member-actions` (from `task/T18f-assets-design`) |
| commit | `f5f0e42` |
| range | `1efc57e..f5f0e42` (r3's target, to this commit): 26 files, +1,145 / −57 |

`6f512dc` and `4545e2f` only add r3's verdict and merge it. Commits after `f5f0e42` change only this
file. Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9.

## 1. The requirement

Everything in the t18d, t18e and t18f briefs' §1 still holds. In addition:

- Every figure shown from a u64 is exact (no JS Number), and "what a wallet shows" uses the
  program's floor of the multiplier (SPEC I5, `toFixed1e9`).
- Member actions (SPEC §5): add_stock and top_up_reserve for a member who has not defaulted while
  the circle runs; withdraw once Completed or Cancelled and not yet withdrawn; signed only by the
  member; refusals in the program's words.
- Buy in place: the server builds Jupiter's swap for a mint from the registry (never the browser),
  and returns it only if it is paid by the buyer and invokes Jupiter's program; the buyer signs in
  their own wallet; the server relays only a signed Jupiter swap paid by that wallet, through a
  server-only RPC URL it never echoes. Othello holds no key and no funds.
- How it works states the planned fee as a plan, not in this version, and says locking pays no APR.

## 2. What changed

| where | what |
|---|---|
| `lib/format.ts`, `BuyPanel.tsx`, `AssetDetail.tsx` | r3: floor via toFixed1e9; exact quote rows; hook authority counted |
| `lib/actions.ts`, `components/live/LiveCircle.tsx`, `Circle.module.css` | addStockIx, topUpReserveIx, withdrawIx, parseUnits; "Your seat" tools |
| `lib/swap.ts`, `app/api/swap/route.ts`, `app/api/swap/send/route.ts`, `BuyPanel.tsx` | Buy in place |
| `components/othello/StockSearch.*`, `Shell.tsx` | top-bar search over the 22 listed xStocks |
| `components/howitworks/HowItWorks.tsx` | collateral wording; step 7, what members get and how Othello plans to earn |
| `components/portfolio/Portfolio.tsx`, `AssetDetail.module.css` | adversary pass 4: stable colours, readable power chips |
| tests | `app-actions` (+5 bankrun), `app-live-guards` (+2), `app-swap` (10), `app-stock-search` (3), `app-portfolio-exact` (+1, Codex's case), `t18f-shown-tokens-adversary`, `t18f-powers-tile-contrast-adversary`; three LiveCircle render harnesses count five useState calls |

## 3. Already attacked

Adversary pass 4 on `1efc57e` found the multiplier rounding and the unreadable power chips; both fixed
here with its tests. Swap checks mutation-tested: removing the payer, Jupiter or signature check each
fails app-swap. No real mainnet transaction was sent (forbidden to the builder); Joshua will make the
first small real buy on staging.

## 4. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-t18g
git branch --show-current   # must print task/T18g-member-actions; do not check out anything else
corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
git diff --check 1efc57e..f5f0e42
./scripts/check-secrets.sh
```

`target/` is already built here; do not run `anchor build`. Read-only requests to devnet, mainnet,
Jupiter and GeckoTerminal are fine, sparingly. Never send a transaction (mainnet or devnet), never
run the ops scripts, never read a keypair, any .env* file, ~/.config/solana or ~/.config/othello-demo.

## 5. Thin, stated rather than discovered

- /api/swap/send relays any signed Jupiter swap paid by the stated wallet; it is not rate-limited,
  so its cost is our RPC quota. It cannot relay anything else.
- The buyer's wallet must be on mainnet; the app cannot read a wallet's network, so it says so.
- The issuer-powers count change has no dedicated render test.
- The top-bar search is tested at its match function, not in a browser.

## 6. Output

Replace `reviews/t18d-review.md` (round 4; the gate reads that file). FIRST line exactly
`VERDICT: implementation-ready` or `VERDICT: changes required`; then findings with severity
(BLOCKER / MAJOR / MINOR), INSIDE or OUTSIDE, file:line and a concrete failure scenario; U7; U8;
and the verification commands with their real output.
