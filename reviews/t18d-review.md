VERDICT: changes required

Target reviewed: `1d2d579` (`72114c0..1d2d579`), confirmed by `git -C /home/hr/myvscode_linux/othello-b1 rev-parse --short HEAD` before review.

## Prior MAJORs

1. **RESOLVED — listed mint/output binding.** `checkSwapAccounts` now permits exactly one Jupiter `route` instruction, maps its first seven accounts against the published V6 IDL, derives the buyer's classic-USDC and Token-2022 xStock ATAs, and requires the source, both possible destinations, destination mint, and no-fee fields to match. The authoritative IDL identifies the ordered `route` accounts and argument tail: [Jupiter V6 IDL](https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts#L5-L70). The recorded real transaction and the rebuilt-v0 adversary fixture both exercise the optional-account sentinel (`JUP6...`) and a real lookup table.

2. **RESOLVED — signature returned by the relay.** The send route derives base58 from signature slot zero of the decoded transaction, rejects an RPC result that differs byte-for-byte, polls that derived value, and never inserts RPC text into its JSON response. The new tests cover non-string results, whitespace, another signature, RPC errors, and status-error text.

## Adversary-derived checks

All requested B1 checks are **RESOLVED**: `destinationTokenAccount` is either the Anchor optional sentinel or the buyer's output ATA; `platformFeeAccount` is the sentinel and `platform_fee_bps` is zero; `slippage_bps <= 100`; and both route amounts are positive. The checker also rejects alternate Jupiter discriminators, a second Jupiter instruction, wrong source/output/mint/token-program accounts, wrong or overlong ATA creates, and bad/missing lookup-table indexes. `resolveKeys` matches web3.js's two-table writable-then-readonly ordering.

## New findings

### MAJOR — the relay accepts a different, arbitrary Jupiter purchase instead of the server-built one

**INSIDE — `app/src/lib/swap.ts:206-217`; `app/src/app/api/swap/send/route.ts:31-51`.** The check treats the whole variable-length `routePlan` as opaque and checks only the final 19 bytes. It requires `in_amount` and `quoted_out_amount` merely to be nonzero; it does not decode/validate the plan, bind either amount or the minimum output to the quote produced in `/api/swap`, or bind the signed message to the transaction that `/api/swap` built. The send endpoint therefore accepts any buyer-signed `route` with the correct two ATAs and a positive, 1%-slippage tail.

Concrete failure: after a buyer requests a 0.10-USDC quote, a compromised browser (or a substituted client) can present the wallet with another syntactically valid route that debits the buyer's full USDC ATA, names a tiny positive quoted output and the same listed-mint ATA, then submit it to `/api/swap/send`. It passes these checks although it is not the 0.10-USDC purchase the server quoted. This is especially unsafe because Jupiter's own audit says malformed route plans are a client responsibility and documents that a corrupted plan which still passes its final-output slippage check can leave residual value in shared token accounts: [Jupiter Aggregator audit](https://developers.jup.ag/assets/files/Jupiter-Aggregator-Apr-2024-0c8eea115e78830ed70ce748b47debfa.pdf).

Store a short-lived server-side record keyed to the build response (buyer, symbol, message hash, input amount, minimum output, expiry), and accept on send only the same message after its signature slots are filled. At a minimum, fully Borsh-decode `routePlan`, enforce the expected amount/minimum output, and make the quote-to-send binding explicit. Add mutations for a high `in_amount`, dust `quoted_out_amount`, changed route-plan bytes, and a different valid route transaction.

### MINOR — “signed by this wallet” means nonzero bytes, not a valid signature

**INSIDE — `app/src/lib/swap.ts:61`; `app/src/lib/swap.ts:122-125`.** Both predicates accept any nonzero 64-byte value. Replacing the fee-payer signature in an otherwise valid serialized transaction with random nonzero bytes passes `checkSwapTx` and reaches `sendTransaction`; `signedTransactionSignature` simply renders those bytes. A normal RPC with preflight rejects it, so this is not a value-transfer bypass, but it contradicts the validator's signed-transaction contract and makes success depend on the provider being honest. Verify signature zero against `tx.message.serialize()` and static key zero before relay; add a corrupted-signature refusal test.

## U7

Findings: **2 INSIDE, 0 OUTSIDE**. This is indicative rather than a blind-review measurement: this single prompt explicitly called out route-plan arguments and signedness, so the all-INSIDE result is a framing warning, not evidence of neutral coverage.

## U8 — not checked

No transaction was sent and no ops script, `.env*`, keystore, or credential was read. I did not live-sign with a wallet, relay against a real RPC, or execute the Jupiter program against a custom malformed route plan; the major finding follows from the code's missing build/send binding and Jupiter's published audit, not a live drain reproduction. The rest of the repository and third-party runtime implementation were not exhaustively audited.

## Verification

All commands below ran from `/home/hr/myvscode_linux/othello-b1`.

```text
git rev-parse --short HEAD
1d2d579

corepack pnpm@10.32.1 install --frozen-lockfile
(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
Lockfile is up to date; Already up to date (both workspaces)

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f" || exit 1; done
exit 0
Notable B1 output: 43 passing (342ms); app-swap output: 25 passing (281ms)

pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit)
exit 0

(cd app && corepack pnpm@10.32.1 build)
exit 0 — Next.js 15.5.26, compiled successfully; generated 109/109 static pages

git diff --check 72114c0..1d2d579
exit 0

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
