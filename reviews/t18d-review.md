VERDICT: changes required

Target reviewed: `276953a683c4d9d2590c25ca85608c2ef70175a` (`72114c0..276953a`). I confirmed `git -C /home/hr/myvscode_linux/othello-b1 rev-parse --short HEAD` returned `276953a` before review.

## Status of prior findings

* Original MAJOR 1, listed-mint/output binding: **RESOLVED.** `checkSwapAccounts` accepts one `route` instruction only, derives the buyer's USDC and Token-2022 output ATAs, and binds route accounts 0--6 including both optional-account sentinels. The published V6 IDL actually lists `route` in that order and gives the four fixed tail arguments: [Jupiter V6 IDL](https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts#L5-L70). The checked real fixture has one route-plan step and the expected tail (`inAmount=1000000`, `quotedOutAmount=133885`, `slippageBps=100`, fee zero).
* Original MAJOR 2, returned relay signature: **RESOLVED.** The relay derives the base58 value from signature slot zero of the decoded transaction, checks the RPC answer for exact equality, polls that derived value, and does not return provider text.
* Fresh-review MAJOR, relay must be bound to the server-built transaction: **PARTLY RESOLVED.** A post-build message mutation, lookup-table substitution, and raw-byte suffix are stopped: the HMAC covers the decoded message and the relay sends its reserialization. But the public build endpoint is a sealing oracle for any amount and the server does not verify that the provider's transaction matches the quote/request (new MAJORs below). Thus it is not bound to the buyer's intended server-side purchase.
* Fresh-review MINOR, “signed” meant nonzero bytes: **RESOLVED.** `@noble/curves` verifies signature zero over the serialized message with `zip215: false` and rejects small-order fee-payer and R points before RPC use.

## Adversary-derived checks

The requested instruction-level checks are **RESOLVED**: slot 4 is the Jupiter optional sentinel or the buyer's output ATA; platform-fee account is the sentinel with zero fee; slippage is at most 100; and route `in_amount`/`quoted_out_amount` are nonzero. The lookup-table ordering test covers multiple tables. The new seal parser, missing-key refusal, strict signature check, derived-signature comparison, and checked-byte reserialization are also covered and pass.

Those facts do not establish that the positive amounts, route plan, remaining accounts, or displayed quote are the purchase the buyer asked the server to build. The IDL makes `routePlan` a variable vector before the fixed tail; it is a topologically sorted trade DAG, not padding ([IDL](https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts#L5-L70), [RoutePlanStep definition](https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts#L786-L810)).

## New findings

### MAJOR — a public build endpoint turns the seal into an authorization oracle

**INSIDE — `app/src/app/api/swap/route.ts:29-83`; `app/src/lib/swapSeal.ts:29-57`.** The only asserted identity at build time is a public key supplied in unauthenticated JSON. Anyone who knows a wallet address can ask `/api/swap` to build any listed-symbol amount from 0.10 through 100,000 USDC for that address and receive a valid, 120-second seal. The seal binds that attacker-selected message to the public address, not to an authenticated buyer intent, a UI quote, a session, or the amount the buyer entered.

Concrete failure: after a buyer has obtained a 0.10-USDC quote, a compromised browser posts `{ user: victim, symbol: "NVDAx", usdc: "100000" }` directly to the same public route. It receives a server HMAC for the resulting high-value message, presents that transaction to the wallet, and relays it with the valid seal after the wallet signs. `/api/swap/send` correctly recognizes it as “the swap Othello built,” but it was built on behalf of an attacker-controlled request. This is precisely the client-substitution boundary the seal was meant to close; an HMAC is authenticity of the server response, not authorization of the public request.

Require a wallet-authenticated, canonical build intent that commits to buyer, symbol, normalized amount, expiry, and a server nonce before creating a swap/seal; verify that intent at build and bind its digest into the relay authorization. A browser-held or merely HttpOnly session is not an equivalent protection against the compromised-client threat. The stateless HMAC can remain for cross-instance verification only if every instance shares the same secret, but it cannot supply this missing user authorization.

### MAJOR — `/api/swap` seals a transaction that need not be the quote or amount it requested

**INSIDE — `app/src/app/api/swap/route.ts:50-83`; `app/src/lib/swap.ts:229-240`; `tests/app-swap.spec.ts:67-100,328-340`.** The route sends `amount=micro` to `/quote`, but it neither parses `quote.inAmount` nor compares the quote to the Jupiter instruction. `checkSwapAccounts` only requires positive `inAmount` and `quotedOutAmount`; it does not Borsh-decode/consume the route plan or require `inAmount === micro`, `quotedOutAmount === quote.outAmount`, and the expected minimum-output relationship. It also leaves the route-plan steps and remaining accounts completely unchecked.

The positive test proves the mismatch rather than detecting it: `approvedTx` hard-codes an empty route plan and `inAmount=1_000_000` (1 USDC), while the test calls `/api/swap` with `usdc: "50"` and asserts HTTP 200. The recorded real Jupiter message instead has a one-step plan. Thus the synthetic success case is not faithful to the real route and actively blesses a transaction/quote disagreement.

Concrete failure: a compromised/misbehaving swap provider, or a future integration defect between quote and swap responses, returns a route with the buyer's USDC ATA, buyer output ATA, listed mint, no platform fee, and an `inAmount` up to the buyer's full balance but a tiny positive quoted output. It passes every current account/amount check, is sealed by the server, and can be signed and relayed. The UI displays the separate quote values, not the transaction it authorizes. The HMAC makes this discrepancy immutable; it does not make it safe.

Parse the V6 `route` Borsh arguments completely (including a route-plan length that consumes exactly to the fixed tail), reject unsupported step/remaining-account shapes unless their safety is established, and bind the normalized request plus quote facts to the on-chain arguments before sealing. At minimum reject if the returned quote's input differs from `micro` or if the route tail differs from the verified quote/request; add a regression using this existing 50-versus-1 mismatch and a real nonempty-plan transaction.

## U7

Findings: **2 INSIDE, 0 OUTSIDE**. This is indicative, not a blind-review measurement: the one-prompt brief explicitly named seal design, route-plan steps, remaining accounts, and test fidelity. The all-INSIDE count is therefore a framing warning, not evidence that the review was neutral.

## U8 — not checked

No transaction was sent; no ops script, `.env*`, keystore, or credential was read. I did not live-sign with a wallet, ask Jupiter or a public RPC to construct a transaction, or execute a malicious route on chain. I inspected the current published V6 IDL but did not independently audit the deployed Jupiter program, its complete route-plan/remaining-account ABI, wallet confirmation UX, deployment secret distribution, or third-party `@noble/curves` implementation. The supplier-mismatch finding follows from the code and its local synthetic test, not from a live-provider compromise.

I compared the test changes with `72114c0`; I found no skipped/deleted existing test or explicit assertion relaxation. The new synthetic positive route is nevertheless not execution-faithful and masks the quote/transaction mismatch described above.

## Verification

Commands ran from `/home/hr/myvscode_linux/othello-b1`:

```text
git -C /home/hr/myvscode_linux/othello-b1 rev-parse --short HEAD
276953a

corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 356ms using pnpm v10.32.1
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 652ms using pnpm v10.32.1

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f" || echo "FAILED $f"; done
exit=0; no FAILED line
Relevant B1 output:
  app-swap: 33 passing (348ms)
  b1-adversary: 43 passing (340ms)
  b1-seal-adversary: 19 passing (300ms)

pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit=0
✓ Compiled successfully in 5.0s
✓ Generating static pages (109/109)

git diff --check 72114c0..276953a
exit=0

./scripts/check-secrets.sh
no credential-shaped strings in client output

Read-only fixture inspection:
{"routeDataBytes":35,"routePlanLength":1,"prefix":"e517cb977ae3ad2a010000002864000140420f0000000000","tail":"40420f0000000000fd0a020000000000640000","inAmount":"1000000","quotedOut":"133885","slippageBps":100,"platformFeeBps":0}
```
