# Done

Append-only. Never edit an entry. One entry per completed task.

Template:

## T00 - YYYY-MM-DD
commit: <sha>
verified: <the exact command that was run>
output:
```
<the real output, pasted, not summarised>
```
reviewed: reviews/gate-N-review.md | verdict: implementation-ready | C0 M1 m3
notes: <anything discovered that changed the design>

The `reviewed:` line is required. Code built by Claude Code is reviewed by Codex,
never by the model that wrote it. If a task genuinely needed no independent review,
write `reviewed: n/a (<why>)` so the decision is visible rather than missing.

---

## T00 - 2026-09-21
commit: 0d67171
verified: `pnpm tsx ops/fetch-fixtures.ts && ls tests/fixtures`
output:
```
AAPLx  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp  decimals=8  multiplier=1.0026642075893797  newMultiplier=1.0032690125398187  effectiveAt=1786149000  slot=449131075
NFLXx  XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL  decimals=8  multiplier=1  newMultiplier=10  effectiveAt=1763337300  slot=449131076
SPYx   XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W  decimals=8  multiplier=1.003909240011759  newMultiplier=1.005714560286254  effectiveAt=1781755200  slot=449131076
NVDAx  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh  decimals=8  multiplier=1.0009180758490996  newMultiplier=1.001701196801074  effectiveAt=1789000200  slot=449131077
NFLXx acceptance OK: multiplier 1, newMultiplier 10, ts 1763337300
AAPLx.json
NFLXx.json
NVDAx.json
SPYx.json
exit=0
```
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: DEFECT fixed in 0d67171, attacks run: 9, test: tests/t00-mint-symbol-verification.ts
notes: SPYx and NVDAx addresses are not in the pack. Sourced from Backed's own
product pages (assets.backed.fi, `data-network-address`), then verified on-chain
before entering the allowlist: Token-2022 owner, ScaledUiAmountConfig present,
the symbol read from the mint's own TokenMetadata, and the mint pubkey inside
that metadata bound to the address the bytes came from. All four decimals=8, all
four share the scaled-UI authority S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS.

The adversary DEFECT: the symbol check was skipped entirely when metadata was
absent or unreadable, so an unidentified mint became a "verified" fixture, and a
swallowed throw let a hostile issuer switch the check off. Test proven to fail
against the vulnerable guard and pass against the fix.

Adversary's unproven suspicion turned out to be a real gap and is closed: only
NFLXx was asserted, so a drifted AAPLx fixture would have passed T00 and only
surfaced at T02/T03. The values SPEC 9b.1 records are now asserted for both, and
drift stops the run rather than being absorbed, since it would mean the SPEC
section 10 G1 vectors are stale. That is a design decision, not a build one.

Caught during verification: an edit of mine had deleted the writeFileSync call,
so the fetcher verified everything and wrote nothing, which made the adversary
test pass vacuously. Restored, and every result above re-run against code that
writes.

## T00 revision - 2026-09-21 (Codex round 1)
commit: see below
verified: `pnpm tsx ops/fetch-fixtures.ts` and `pnpm tsx tests/t00-mint-symbol-verification.ts`
output:
```
AAPLx  ...  multiplier=1.0026642075893797  newMultiplier=1.0032690125398187  effectiveAt=1786149000
NFLXx  ...  multiplier=1  newMultiplier=10  effectiveAt=1763337300
SPYx   ...  multiplier=1.003909240011759   newMultiplier=1.005714560286254  effectiveAt=1781755200
NVDAx  ...  multiplier=1.0009180758490996  newMultiplier=1.001701196801074  effectiveAt=1789000200
NFLXx acceptance OK: multiplier 1, newMultiplier 10, ts 1763337300
exit=0

OK: 10 cases, only a mint that proves its identity becomes a fixture
exit=0
```
reviewed: Codex VERDICT: REVISE on 3270b45, all 6 findings fixed, awaiting re-review
adversary: covered by round 0; its test was rewritten to 10 cases per Codex finding 5
notes: Codex findings and fixes, in its order.
1 MAJOR, genesis: SOLANA_RPC_URL accepted any endpoint. assertMainnet() now calls
  getGenesisHash and refuses anything but 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d,
  read from api.mainnet-beta.solana.com 2026-09-21.
2 MAJOR, provenance: self-reported symbol and embedded mint prove nothing, since an
  attacker controls both. Pinned three anchors that need Backed's keys, taken from the
  two mints SPEC 9b.1 verifies independently of this script: scaled-UI authority
  S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS, metadata update authority
  5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq, and a xstocks-metadata.backed.fi URI
  whose path names the symbol. Removing the URI check alone lets a genuine Backed mint
  be relabelled as another xStock and accepted, proven by mutation.
3 MINOR, TLV: now asserts account type is Mint, rejects trailing bytes, rejects a
  duplicated extension instead of taking the first, and requires ScaledUiAmountConfig
  to be exactly 56 bytes.
4 MAJOR outside: writes were incremental, so a late failure left a mixed snapshot for
  T03/T06. All fixtures are staged in a temp dir and renamed in only after every mint
  passes. Every failing case now asserts nothing was left on disk.
5 MINOR, test: rewritten from 2 cases to 10, each asserting its own specific failure
  text so a case cannot pass on an unrelated error, plus a positive control. It caught
  a real flaw in my own case design immediately: the authority case was failing on the
  embedded-mint check instead.
6 MINOR outside: P1's verify command is now `pnpm tsx tests/p1-harness-proof.ts`.

Codex's output is deliberately NOT written to reviews/*review*.md: check-reviews.sh
requires `VERDICT: implementation-ready` or `changes required` there, and fails on the
latter, so a REVISE verdict in that path would break the harness. Gate reviews go
there at T07; task-level rounds live here.

## T00 revision - 2026-09-21 (Codex round 2)
commit: see below
verified: `pnpm tsx ops/fetch-fixtures.ts` and `pnpm tsx tests/t00-mint-symbol-verification.ts`
output:
```
AAPLx/NFLXx/SPYx/NVDAx fetched, NFLXx acceptance OK, exit=0
OK: 11 cases, only a mint that proves its identity becomes a fixture, exit=0

SOLANA_RPC_URL http://127.0.0.1:9 is http:, not https. ... exit=1
SOLANA_RPC_URL host example.com is not one of the trusted endpoints ... exit=1
```
reviewed: Codex VERDICT: REVISE on df6f61a, 2 CRITICAL + 1 MINOR addressed, awaiting re-review
adversary: covered by round 0; suite now 11 cases
notes: Codex was right twice, and the second one removed a claim rather than fixing code.

CRITICAL 1, transport. A genesis hash is public, so an endpoint returning the right
one proves nothing about who answered; the test's own stub returned it and was
accepted. Production now requires https to a host in TRUSTED_RPC_HOSTS, and TLS
authenticates it. The fake-RPC seam is separate and explicit:
OTHELLO_INSECURE_TEST_RPC=1 warns loudly and stamps every fixture it writes
endpointTrusted:false. The suite asserts the committed fixtures carry true, so the
seam cannot leak into the artifacts T03/T06 load.

CRITICAL 2, provenance. The three "Backed-key" anchors were copyable: Token-2022
takes the scaled-UI authority and the metadata update authority as non-signer
instruction data, so a counterfeit mint can carry Backed's public keys without
holding them, and the URI is attacker-chosen. The claim was wrong, so it was removed
rather than patched: those checks are now labelled integrity and drift checks in both
files. The binding that does hold is Backed's own product page over TLS, fetched at a
URL this repo derives from the symbol rather than from anything the mint says, and
required to state data-network-address="<address>". Verified live for all four.
The residue, that this makes backed.fi's TLS and DNS the trust root and that
SPYx/NVDAx are still not in SPEC 9b.1, is recorded in OPEN-QUESTIONS.md as BLOCKING
before T07. It is Joshua's decision, not the build's.

MINOR 3, atomicity. Four renameSync calls could fail midway, and /tmp can be another
filesystem. Staging now sits beside the destination, the swap is a single
same-filesystem directory rename, and a failure rolls the previous set back.
