VERDICT: changes required

Review target: `5fb67a8` (`dbf9a6e..5fb67a8`). The worktree remained on
`task/T18h-final`; `HEAD` is `5fb67a8`. I read the target commit message and
the round-four review before the prompted checks.

## Round-four findings

1. **Fixed — MAJOR — INSIDE — `app/src/app/api/swap/route.ts:28-36`:** the
   route now accepts `usdc` only as a string matched by the plain-decimal
   expression and converts its digits with `BigInt`. A JSON numeric `1e2` is
   rejected before Jupiter is contacted; `tests/app-swap.spec.ts:152-160` and
   `tests/t18g-swap-amount-adversary.spec.ts` cover that case.

2. **Not fixed — MAJOR — INSIDE — `app/src/lib/swap.ts:23-56`, used by
   `app/src/app/api/swap/send/route.ts:35-44`:** rejecting a System Program
   instruction is not enough. `checkSwapTx` now allows the classic SPL Token
   program at top level, but it does not decode any allowed instruction or
   constrain its accounts and data. A buyer-signed transaction can therefore
   contain a valid Jupiter swap plus an unrelated classic-SPL `Transfer` or
   `TransferChecked`, and still pass lines 51-55. It is also not bound to a
   registry output mint at the public `/api/swap/send` boundary.

   Concrete failure: I constructed locally with ephemeral keys, without an RPC
   request or transaction, a signed V0 message containing a Jupiter
   instruction and a one-unit classic-SPL Token transfer. The current
   `checkSwapTx(encoded, buyer, true).ok` returned `true`. A caller can submit
   the analogous signed, valid Jupiter transaction with an extra token transfer
   to the relay. The server is consequently not limited to relaying only the
   claimed swap class. Parse and constrain the complete instruction/account
   effects to the expected USDC-to-registry-mint swap (including a bounded
   compute-budget policy), or do not provide a server relay. Add an adversary
   test for a valid Jupiter transaction plus each allowed but unrelated token
   instruction.

3. **Not fixed — MAJOR — INSIDE — `app/src/app/api/swap/send/route.ts:47-50`:**
   the catch path at lines 56-71 now uses fixed wording, but the ordinary
   `getSignatureStatuses` failure path returns `JSON.stringify(s.err)` directly
   to the browser. `s.err` is provider-supplied data. This contradicts both the
   commit's “no provider text” claim and the stated key-leak requirement.

   Concrete failure: an RPC response with
   `result.value[0].err: "key ab12 rejected"` produces a 200 response carrying
   `error: "\\\"key ab12 rejected\\\""`. A short credential or any other
   provider text therefore escapes despite the new catch-path tests. Return a
   fixed on-chain-failure message instead, and test a status response whose
   `err` contains a standalone credential.

## New findings

**MAJOR — INSIDE — `app/src/components/assets/BuyPanel.tsx:50-80, 85-106,
193-198`:** the displayed quote is not tied to the amount that is submitted.
Changing the input clears `quote` only in a passive `useEffect`; until that
effect runs, the prior quote keeps Buy enabled. `onBuy` submits the new
`amount.trim()` at line 95, while the post-confirmation pop-up describes the
old `quote.outRaw` and `quote.usdc` at lines 197-198.

Concrete failure: after receiving a 50-USDC quote, change the amount to 100
and activate Buy before the quote invalidation/render completes. The server
builds and the wallet signs the 100-USDC swap, but the confirmed-purchase popup
can say it bought the 50-USDC quote's output “for 50 USDC.” Invalidate the
quote synchronously in the input handler, bind a quote to the exact parsed
input amount, and carry the build response that was actually signed into the
confirmation. Add a component adversary test for this edit-then-buy sequence.

**MINOR — OUTSIDE — `app/src/app/api/wallet/route.ts:15-18, 31-38`:** the new
route promises a lamport string but parses `getBalance` JSON with
`response.json()`, where the RPC's u64 `value` becomes a JavaScript `number`.
Above `Number.MAX_SAFE_INTEGER` it has already been rounded before line 38
converts it to a string; `exactTokens` in BuyPanel and Portfolio then presents
the rounded amount as exact. USDC is correctly accumulated from decimal strings.

Concrete failure: an RPC result of `9007199254740993` lamports becomes
`9007199254740992` in this route and is shown one lamport short. Preserve the
raw numeric lexeme and parse it as `BigInt` (or avoid presenting SOL as an exact
integer); add a route test at `2^53 + 1`. No `/api/wallet` route or hook test
exists in this range.

## U7

- Findings: **INSIDE 3, OUTSIDE 1**. This is indicative rather than a rigorous
  cold-read measurement: this was a single-prompt review that supplied the
  prior findings and intended repairs alongside the target (protocol U1).

## U8 — not checked

- I did not run an `ops/` script, send a transaction, make a live mainnet or
  Jupiter request, or read a keypair, `.env*`, `~/.config/solana`, or
  `~/.config/othello-demo`.
- I did not run `anchor build`, as instructed, because it can read the local
  deploy keypair. The prebuilt artifact was used by the serial specs.
- I did not reproduce browser-wallet signing, a live Jupiter quote/swap, relay
  behaviour against a real RPC, or physical-device layout. The local validator
  probe used fresh in-memory keys only and never connected to a cluster.
- The serial asset adversary harness prints wallet-provider-missing stack traces
  while deliberately server-rendering an unwrapped component. Its process
  nonetheless exited 0 and its assertion passed; I did not treat that harness
  noise as a product finding.

## Verification (serial)

```text
git branch --show-current; git rev-parse --short HEAD
task/T18h-final
5fb67a8

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
exit 0; each spec ran in its own process. The app-swap tests reported 15
passing, including the real Jupiter fixture, numeric-amount refusal, and the
catch-path provider-text cases. The serial suite completed successfully.

Local decoder probe: a buyer-signed V0 transaction containing Jupiter plus a
classic-SPL Token transfer, passed to checkSwapTx(encoded, buyer, true)
true

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check dbf9a6e..5fb67a8
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
