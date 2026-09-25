VERDICT: changes required

Recorded by the builder from Codex's own output (pasted by Joshua, 2026-09-25 ~19:55 Lagos): Codex
deleted this file while replacing it and hit its usage limit before writing the new one. The text
below is Codex's; nothing is added except this note and the headings marking the two runs.

## Codex re-check on `a5a4ccc` (97f0c43..a5a4ccc), its final words

"The targeted checks pass, including the real lookup-table fixture. The verdict remains changes
required because the new account check proves only that the listed mint appears somewhere in the
message, and the signature check proves only that the RPC returned a signature-shaped string."

Open, therefore:
- MAJOR — `app/src/lib/swap.ts` checkSwapAccounts: the listed mint must be bound to the swap's
  output (Jupiter instruction's destination accounts / buyer-owned output ATA), not merely present.
- MAJOR — `app/src/app/api/swap/send/route.ts`: derive the signature from the signed transaction and
  require the RPC result to equal it (or return only the derived value).

## Codex final round on `97f0c43` (5fb67a8..97f0c43)

Round-five findings: 1 (relay binds only program ids; ATA owner/mint, output mint and compute budget
not checked) NOT FIXED, MAJOR; 2 (the RPC's sendTransaction result returned verbatim) NOT FIXED,
MAJOR; 3 (stale quote in the funds gate) NOT FIXED, MAJOR; 4 (lamport precision) FIXED, MINOR.
The builder's a5a4ccc addressed 1 (partly, per the re-check above), 2 (shape only), and 3 (typed
amount). Verification on 97f0c43: full serial suite exit 0; root and app tsc exit 0; Next 15.5.26
build, 109 pages; git diff --check exit 0; check-secrets clean. U8: no transaction, ops script,
keypair or env file; no live wallet signing or relay against a real RPC.
