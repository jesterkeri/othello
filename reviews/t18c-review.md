VERDICT: changes required

Review target: `b223a46` (`f95c4b4..b223a46`). `HEAD` was
`b223a46990060e506279e2889edfea349a771def`.

## Findings

**MAJOR — INSIDE — `app/src/components/howitworks/HowItWorks.tsx:48-49,72,95-99`:**
the judge-path explainer promises outcomes the protocol does not guarantee.
“Nobody has to trust anybody” contradicts KNOWN-LIMITS L7 (a real-xStock
issuer can freeze, pause, or move the vault) and L10 (a person must submit
every release/default/top-up transition). “They still own it and get it back
at the end” is false for a post-payout defaulter: SPEC §6 sells `sell_raw` and
forfeits guarantee/top-ups. “The rest of the circle keeps getting paid” is
also unconditional where SPEC §6 permits `pool_insufficient` (the default
reverts) and an escrow deficit that pauses the next payout until somebody tops
up. A judge following this new page is told the product eliminates precisely
the residual risks the design pack says it retains. Make the healthy-case
return conditional; say surplus collateral returns after default; say a
shortfall may pause the circle; and state the issuer/permissionless-action
limits without claiming a trustless automatic outcome.

**MAJOR — INSIDE — `app/src/app/api/quote/route.ts:34-41` and
`app/src/components/assets/BuyPanel.tsx:73-80`:** a structurally incomplete
but successful Jupiter response is converted into invented trade information.
The route accepts any truthy `outAmount`, defaults a missing `priceImpactPct`
to `0`, and turns a missing `routePlan` into `[]`; the UI consequently says
`0.00%` impact and `direct`. For example, a compatible upstream response
`{ outAmount: "100000000" }` returns HTTP 200 and tells the buyer a zero-impact
direct route although Jupiter supplied neither fact. A non-numeric outAmount
or impact reaches the UI as `NaN`. This violates the stated “real data or a
clear error; never a made-up number” rule on a real-money hand-off. Validate a
decimal-integer out amount, finite non-negative impact, and a non-empty route;
otherwise return a route-owned 502/clear unavailable state. Canonicalize the
quoted micro-USDC amount too: `Math.round(usdc * 1e6)` can differ from the
unrounded `usdc` returned to the UI (for example `1.0000004` is quoted to
Jupiter as 1.000000 but reported as 1.0000004).

## Scope checks

- The corrected live-round status uses the strict `now > deadline + grace`
  boundary; the new adversary spec verifies exact-boundary refusal and the
  next-second control.
- The Portfolio suppresses its dollar total when any holding has no Jupiter
  price; its adversary test covers the 429 case.
- `/api/live` preserves readable catalog entries if one mint cannot decode,
  and the detail page names that asset as unavailable. The catalog marks
  paused mints and the detail page suppresses Buy for them.
- The two external data endpoints most likely to drift, `/api/quote` and
  `/api/chart`, have no direct route/component regression test. The quote
  defect above is in that untested surface.

## U7

- Findings: **INSIDE 2, OUTSIDE 0**. This is indicative, not a rigorous
  cold-read measurement: the prompt supplied its requirements and known
  adversary concerns in one turn (protocol U1).

## U8 — not checked

- I did not run any ops script, send a transaction, make an RPC/API read, or
  open any keypair, `.env*` content, `~/.config/solana`, or
  `~/.config/othello-demo` file.
- I did not run `anchor build`: its program-id validation automatically reads
  the local deploy keypair, contrary to the no-keypair rule. No Rust program
  source changes in this range require it.
- I did not reproduce wallet signing, browser screenshots, Vercel deployment,
  Jupiter/GeckoTerminal live behavior, or an audit of the snapshot registry's
  issuer authority/liquidity/routability claims.

## Verification (serial)

```text
git checkout b223a46
HEAD is now at b223a46 Judge-path adversary fixes ...

git diff --stat f95c4b4..b223a46
38 files changed, 1681 insertions(+), 75 deletions(-)

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (contents not read).

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
36 files, one process per file: 203 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check f95c4b4..b223a46
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
