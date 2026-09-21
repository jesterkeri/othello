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
