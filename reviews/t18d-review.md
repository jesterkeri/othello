VERDICT: changes required

Review target: `dbf9a6e` (`1efc57e..dbf9a6e`). The worktree remained on
`task/T18h-final`; `HEAD` is the brief-only follow-up `86d3796`.
`git diff --stat dbf9a6e 86d3796` reports only `reviews/t18h-brief.md`.

## Round-3 findings

1. **Fixed — MAJOR — INSIDE — `app/src/lib/format.ts:22-28`:** `shownTokens` now uses the same bitwise-floor `toFixed1e9` implementation as the program. The real AAPLx multiplier adversary test covers the formerly incorrect final fixed-point digit.

2. **Fixed — MINOR — INSIDE — `app/src/components/assets/BuyPanel.tsx:137-147`:** Jupiter's `outRaw` stays a decimal integer and is rendered with `exactTokens`; the label now accurately says it is before the multiplier rather than raw base units.

3. **Fixed — MINOR — INSIDE — `app/src/components/assets/AssetDetail.tsx:73-80`:** the issuer-power count includes a transfer-hook authority when the extension is enabled but no hook program has yet been installed.

## New findings

**MAJOR — INSIDE — `app/src/app/api/swap/route.ts:30-34`:** the Buy builder still accepts a JSON number, converts it through `String`, and then calls it a plain decimal. JSON has already discarded its lexical spelling at that point. In particular, a request body containing `"usdc": 1e2` is parsed as the number `100`, converted to `"100"`, and builds a 100-USDC Jupiter quote. That is precisely an exponent amount which the requirement and comment say must be refused, not reinterpreted.

Concrete failure: a caller can send `{ "symbol": "NVDAx", "usdc": 1e2, "user": "..." }` to `/api/swap`; the route requests `amount=100000000` from Jupiter rather than returning 400. Require `body.usdc` to be a string and validate that string before any coercion, preferably without trimming it; add a route test whose `req.json()` result has numeric `usdc: 1e2`.

**MAJOR — INSIDE — `app/src/lib/swap.ts:33-38`, used by `app/src/app/api/swap/send/route.ts:35-43`:** `checkSwapTx` accepts a transaction if it contains Jupiter anywhere. It does not require the transaction to consist only of the approved swap, verify the USDC input, registry output mint, or prohibit unrelated value-moving instructions. Consequently the public relay is not limited to the claimed transaction class.

Concrete failure: I constructed locally, without connecting or sending, a buyer-signed V0 transaction with one Jupiter instruction followed by `SystemProgram.transfer` of one lamport to another key. `checkSwapTx(encoded, buyer, true).ok` returned `true`; `/api/swap/send` would relay it. A malicious or compromised upstream response can therefore hand the wallet a mixed transaction, and any caller can use the relay for a signed mixed transaction. The validator must decode and constrain the complete instruction set and account effects to an approved Jupiter swap for the requested USDC and registry mint, or remove the server relay and send the wallet's signed bytes directly through its wallet connection. Add this composite-instruction mutation to `tests/app-swap.spec.ts`.

**MAJOR — INSIDE — `app/src/app/api/swap/send/route.ts:56-61`:** RPC-error scrubbing intentionally excludes URL pieces shorter than 12 characters. The route then returns the remaining RPC error verbatim to the browser. An RPC credential is not required to be 12 characters long, so the stated no-leak property does not hold for every valid `MAINNET_RPC_URL`.

Concrete failure: with `MAINNET_RPC_URL=https://rpc.example/?api-key=shortkey`, an RPC response whose error is `invalid api key shortkey` becomes `sendTransaction: invalid api key shortkey` and reaches BuyPanel unchanged. Percent-encoded URL credentials can also be echoed decoded and miss the raw-string replacement. Do not forward provider error messages to the client; return fixed route-owned errors (or scrub parsed, raw, and decoded URL components regardless of length) and test a short, standalone credential plus a percent-encoded one.

## U7

- Findings: **INSIDE 3, OUTSIDE 0**. This is indicative rather than a rigorous cold-read measurement: the prompt and brief supplied the target, prior findings, and the intended invariants in the same turn (protocol U1).

## U8 — not checked

- I did not run an ops script, send a transaction, make live RPC/API reads, or read any keypair, `.env*` content, `~/.config/solana`, or `~/.config/othello-demo`. A presence-only check confirmed root `.env`, root `.env.local`, and `app/.env.local` are absent.
- I did not run `anchor build`, as instructed, because it can read the local deploy keypair. The already-built artifact was used by the serial bankrun specs.
- I did not reproduce browser-wallet signing, deployment, a real Jupiter quote/swap, relay behaviour against a real RPC, or physical-device layout. The local mixed-instruction probe generated only ephemeral test keys and never connected to a cluster.
- The serial asset adversary spec printed wallet-provider-missing stack traces during its deliberate server-render harness, but its process exited 0 and its stated assertion passed. I did not treat that test-harness noise as a product finding.

## Verification (serial)

```text
git branch --show-current; git rev-parse --short HEAD
task/T18h-final
86d3796

git diff --stat dbf9a6e 86d3796
reviews/t18h-brief.md | 8 ++++----
1 file changed, 4 insertions(+), 4 deletions(-)

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date (bufferutil, esbuild, utf-8-validate build scripts intentionally ignored).

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date (bufferutil, sharp, utf-8-validate build scripts intentionally ignored).

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
exit 0; each spec ran in its own process. The app-actions, app-live-guards, app-swap,
T18f, T18g, T24, and T25 additions all passed. The asset adversary harness printed
wallet-provider-missing stack traces but exited 0 and reported its assertion passing.

Local decoder probe: a signed V0 transaction containing a Jupiter instruction plus
SystemProgram.transfer, passed to checkSwapTx(encoded, buyer, true)
true

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check 1efc57e..dbf9a6e
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (presence-only check).
```
