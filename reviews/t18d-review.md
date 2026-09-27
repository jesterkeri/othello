VERDICT: implementation-ready

Target reviewed: `2ea2aa1` (`72114c0..2ea2aa1`), confirmed with `git -C /home/hr/myvscode_linux/othello-b1 rev-parse --short HEAD` before review.

Prior MAJOR status

- Seal oracle — RESOLVED within the explicitly chosen boundary. `app/src/lib/swapSeal.ts:9-18` says accurately that `/api/swap` is public and is not user authorisation; `app/src/app/api/swap/send/route.ts:53-56` requires a valid, unexpired seal for the exact signed message. README.md:42 makes the same boundary clear: wallet signature authorises; the server is not a defence against a compromised browser or wallet. I found no code path that contradicts that account. The public build endpoint can still produce a valid seal for any supplied wallet and requested amount, by design; the wallet signature and its pre-signing display remain the authorisation point.
- Requested/quoted amount binding — RESOLVED. `app/src/app/api/swap/route.ts:55-56` requires Jupiter's `inAmount` to equal the exact typed micro-USDC amount. After account validation, lines 83-84 require the V6 route tail's `inAmount`, `quotedOutAmount`, and slippage to equal the requested input, quote output, and 100 bps respectively before sealing. The seal covers the serialized message, and the relay recomputes that message from the signed transaction before accepting it.

Adversary-derived checks — RESOLVED

- `checkSwapAccounts` accepts exactly one `route` discriminator and binds the route's source, destination mint, `userDestinationTokenAccount`, optional `destinationTokenAccount`, and Token-2022 program to the buyer's expected ATAs (`app/src/lib/swap.ts:228-252`). It refuses a provided destination other than that ATA, a fee account or nonzero fee bps, slippage above 100, and zero in/quoted-out amounts. ATA creates are restricted to the two expected ATAs (`254-269`).
- The mapping is consistent with [Jupiter's published V6 IDL](https://raw.githubusercontent.com/jup-ag/instruction-parser/master/src/idl/jupiter.ts): `route` lists the seven accounts in the code's order and has `routePlan: vec<RoutePlanStep>`, followed by `inAmount: u64`, `quotedOutAmount: u64`, `slippageBps: u16`, and `platformFeeBps: u8` (IDL lines 5-70). The checked real fixture uses the Jupiter program id for optional slots 4 and 6, so the code's "not provided" encoding is evidence-backed. Parsing the fixed 19-byte suffix is correct for every valid route-plan length because the IDL puts no fields after it.
- The relay verifies slot-zero's fee-payer Ed25519 signature strictly with noble's `zip215: false` check and explicit small-order public-key/R rejection (`app/src/lib/swap.ts:125-149`). It derives the base58 signature from those checked signed bytes, reserializes the checked transaction, and requires the RPC answer to be byte-for-byte that derived value before polling (`app/src/app/api/swap/send/route.ts:65-77`). Provider text is not returned.
- The HMAC is versioned and covers the message hash, canonical buyer, listed symbol, and expiry. It has a 120-second lifetime, rejects malformed/noncanonical spellings and absent/short keys, and works across instances configured with the same server-only secret. Replays cannot execute the same Solana signature twice; expiry bounds the relay acceptance window.

New findings

- MINOR — INSIDE — `tests/app-swap.spec.ts:67-100` and `tests/b1-seal-adversary.spec.ts:69-92`: the new API-success helpers serialize a zero-length `routePlan` (`Buffer.alloc(4)`). That is IDL-shaped but not a faithful executable Jupiter swap: the recorded production fixture has a non-empty route plan. Consequently, successful `/api/swap` sealing and relay tests can pass with a transaction Jupiter would reject on chain, and do not exercise `jupiterRouteTail` on a real variable-length plan through the build route. Use the existing recorded fixture (or a valid non-empty route plan) in a build-route success test, with matching quoted values. This does not undermine the reviewed controls: the account parser already runs against the real fixture and the tail's end-relative layout is correct.

U5: apart from the minor above, the changed security paths have direct tests: real-fixture account mutations, all rejected Jupiter variants, ATA variants, multi-table ordering, malformed seal forms, strict-signature edge cases, RPC odd answers, sealing mismatched messages, and checked-byte relay behavior. I found no weakened assertion when comparing the test diff with `72114c0`; the old coarse swap fixtures were replaced because they no longer satisfied the intentionally stricter account validation.

U7: findings: INSIDE 1, OUTSIDE 0. This is indicative only, not a rigorous cold-review measure: this was a single-prompt review, so U1's required two-stage blind finding/message process was not available.

U8 — not checked

- I did not send a transaction or contact Jupiter/RPC with a live swap. The checked transaction fixture and all route/RPC calls in tests are local/read-only fixtures or stubs.
- I did not inspect deployment environment variables, credentials, or secret-manager configuration. In particular, I could not verify that every production/serverless instance receives the same high-entropy `SWAP_BINDING_SECRET`.
- I did not independently audit Jupiter's on-chain program or decode individual route-plan steps; that is the documented threat-model boundary. I did verify the V6 IDL/account and tail definitions cited above and the repository's recorded real transaction.
- Per instruction, I did not run `anchor build`.

Verification

```text
$ git -C /home/hr/myvscode_linux/othello-b1 rev-parse --short HEAD
2ea2aa1

$ corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 705ms using pnpm v10.32.1
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 1s using pnpm v10.32.1

$ for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f" || echo "FAILED $f"; done
exit=0
No `FAILED tests/...` line was printed. Relevant changed-suite totals:
  app-swap: 34 passing (631ms)
  b1-adversary: 43 passing (676ms)
  b1-seal-adversary: 19 passing (615ms)
  t18g-swap-amount-adversary: 4 passing (300ms)
The complete loop also completed the remaining repository specs with exit=0.

$ pnpm exec tsc --noEmit -p tsconfig.json && (cd app && corepack pnpm@10.32.1 exec tsc --noEmit)
exit=0

$ (cd app && corepack pnpm@10.32.1 build)
✓ Compiled successfully in 8.4s
✓ Generating static pages (109/109)
exit=0

$ git diff --check 72114c0..2ea2aa1
exit=0

$ ./scripts/check-secrets.sh
no credential-shaped strings in client output
exit=0
```
