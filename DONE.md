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

## T00 revision - 2026-09-21 (Codex round 3 + design decision)
commit: see below
verified: `pnpm tsx ops/fetch-fixtures.ts` and `pnpm tsx tests/t00-mint-symbol-verification.ts`
output:
```
fetcher exit=0, four fixtures, NFLXx acceptance OK
OK: 11 cases, only a mint that proves its identity becomes a fixture, exit=0
check-reviews: reviews ok      pack integrity: ok
```
reviewed: Codex VERDICT: REVISE on 7864559, 1 MAJOR + 1 MINOR fixed, awaiting re-review
adversary: covered by round 0; suite 11 cases
notes: Codex MAJOR: the issuer trust root was not actually enforced. `productPage`
only had to be https, its host was never required to be assets.backed.fi, and fetch
followed redirects without checking where it landed, so a wrong entry or a redirect
could satisfy the attribute check and mint a fixture stamped endpointTrusted:true.
Fixed by making the allowlist carry a reviewed SLUG rather than a URL: the origin
https://assets.backed.fi is a constant the script owns, the URL is built from it,
the resulting origin is re-checked, and redirects are refused with
`redirect: "manual"` rather than followed. The fixture records the exact URL that
bound it. Codex MINOR: blank line at EOF in OPEN-QUESTIONS.md, removed.

DESIGN DECISION, Joshua, 2026-09-21: SPYx and NVDAx are added to SPEC 9b.1, and the
trust root is recorded in a new SPEC 9b.6 which states plainly that nothing on-chain
establishes issuer identity and that Backed's HTTPS product page is the accepted
binding. The four-fixture contract is unchanged, so gate 1 was never reduced to two.
The BLOCKING open question is marked RESOLVED with the decision and its date.

SPEC.md is guard-protected and normally corrected in the design session. It was
edited here on the design owner's explicit instruction, and the edit is confined to
9b.1 and the new 9b.6.

## T01 - 2026-09-21
commit: 2144fe6 (workspace in e3b4e5d, adversary fix in 2144fe6)
verified: `anchor build`
output:
```
$ anchor build
    Finished `release` profile [optimized] target(s) in 0.14s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.11s
     Running unittests src/lib.rs (/home/hr/myvscode_linux/othello/target/debug/deps/othello-995034df92de9df1)
exit=0

$ ls -l target/deploy/othello.so target/idl/othello.json; md5sum target/deploy/othello.so
57048 target/deploy/othello.so
239 target/idl/othello.json
1641cf74f70526a52100e894df136e98  target/deploy/othello.so

$ cat target/idl/othello.json
{
  "address": "DhZhSvtTh78ZK26MkVVpyeDYr4MuyTZSVrT5YEFqqrDT",
  "metadata": {
    "name": "othello",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Othello: xStock-backed mutual credit circle"
  },
  "instructions": []
}
$ cargo tree -p othello --depth 1   # resolved, the versions T01 exists to record
othello v0.1.0 (/home/hr/myvscode_linux/othello/programs/othello)
├── anchor-lang v1.1.2
└── anchor-spl v1.1.2
    (transitive, from Cargo.lock)
    spl-token-2022-interface                 2.1.0
    spl-pod                                  0.7.4
    spl-token-metadata-interface             0.8.0
    spl-token-interface                      2.0.0
    spl-associated-token-account-interface   2.0.0

$ anchor --version; solana --version; cargo-build-sbf --version; rustc --version; node --version; pnpm --version
anchor-cli 1.1.2
solana-cli 3.1.10 (src:7bc9c805; feat:1620780344, client:Agave)
solana-cargo-build-sbf 3.1.10
rustc 1.89.0 (29483883e 2025-08-04)
v22.23.2
10.32.1
```
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: DEFECT fixed in 2144fe6, attacks run: 12, test: tests/deploy-artifact.spec.ts
notes: Resolved versions, which is what T01 exists to pin down: anchor-lang 1.1.2,
anchor-spl 1.1.2, spl-token-2022-interface 2.1.0, spl-pod 0.7.4. ARCHITECTURE's
pinned-versions line guessed spl-token-2022-interface 2.1.0 on 2026-09-21 and that
is exactly what resolved, so T02's PodF64 work and T03's StateWithExtensions decode
are against the version the design assumed. anchor-lang and anchor-spl are declared
`~1.1`, not `1.1.2`: a plain caret resolved them to 1.2.0, outside the 1.1.x that
ARCHITECTURE pins.

Two corrections to what the session had recorded earlier. The installed Agave CLI is
3.1.10, not 4.2.2. The build toolchain is pinned to rust 1.89.0, not 1.98.1: `stable`
here carries neither clippy nor rustfmt, 1.89.0 carries both and matches the sbpf
toolchain, and R1's verify command needs them.

The SPEC section 5 instruction surface is deliberately absent, so the default build's
IDL is `"instructions": []`. Each instruction arrives with the task that implements
it rather than as a stub. The one addition is read_clock, the P1 harness probe,
behind the `harness` cargo feature.

ADVERSARY DEFECT, real, found on e3b4e5d. lib.rs documented read_clock as unable to
"reach a deployed build", and the only check read target/idl/othello.json. But
`anchor deploy` uploads target/deploy/othello.so, and the two artifacts are written
by different build steps, so `cargo build-sbf --features harness` rewrote the .so
with the probe in it and left the IDL untouched: the suite stayed green, 3 passing,
over a binary that carried it. The adversary confirmed it live rather than by string
match, loading the .so in LiteSVM at declare_id and calling the read_clock
discriminator, which returned the clock. Not a contrived route: P1 needs a harness
.so and cargo build-sbf is the obvious way to make one. Severity is low today because
read_clock takes no accounts and moves nothing, but the stated control did not exist.

Fixed by reading the artifact that actually ships. The adversary's test is integrated
as tests/deploy-artifact.spec.ts and passes on the gate branch; the reproduction is
recorded below. read_clock now logs a deliberate HARNESS_BUILD_MARKER literal, since
the incidental "Instruction: ReadClock" string can be switched off by Anchor's
no-log-ix-name feature. tests/artifacts.ts refuses to assert on an artifact older
than lib.rs, Cargo.toml or Cargo.lock, because `pnpm test` never builds and a stale
target/ would green either guard on old bytes.

Reproduction of the defect and the fix, run on 2144fe6:
```
$ anchor build && md5sum target/deploy/othello.so
1641cf74f70526a52100e894df136e98  target/deploy/othello.so
$ pnpm run test:unit
4 passing

$ cargo build-sbf --features harness && md5sum target/deploy/othello.so
4abba020c502c54b7a60d5a374172587  target/deploy/othello.so
$ python3 -c "import json;print(json.load(open('target/idl/othello.json'))['instructions'])"
[]                                          <- the IDL guard is blind, as before
$ pnpm run test:unit
AssertionError [ERR_ASSERTION]: target/deploy/othello.so carries the harness probe:
OTHELLO-HARNESS-BUILD-DO-NOT-DEPLOY, Instruction: ReadClock, clock.unix_timestamp=
1 failing

$ anchor build && pnpm run test:unit
4 passing

$ touch programs/othello/src/lib.rs && pnpm run test:unit
AssertionError [ERR_ASSERTION]: target/deploy/othello.so is older than
programs/othello/src/lib.rs. Run `anchor build` before testing; this guard is
meaningless on a stale artifact.
4 failing
```

Three further things the adversary raised as unproven suspicions, all real, all
fixed here. The two T00 suites were not reachable from `anchor test` at all, because
mocha only globs *.spec.ts and they are tsx scripts; `pnpm test` now runs them, so
the fixture-provenance proof is part of the gate rather than something run by hand.
Anchor.toml pinned anchor_version but not solana_version, leaving the toolchain that
produces the deployed bytes floating against PIPELINE's "toolchain pinned"; it now
pins solana_version = "3.1.10". The mocha + tsx substitution for ts-mocha is recorded
in OPEN-QUESTIONS.md rather than by editing the design-owned ARCHITECTURE.md.

Full suite after the fix: `pnpm test` exit 0, 4 mocha cases plus 11 binding-record
cases plus 15 mint-symbol cases. `cargo fmt --check` clean. `cargo clippy
--all-targets -- -D warnings` clean with no features, with `--features harness`, and
the adversary also confirmed it with `--features idl-build`. `pnpm typecheck` clean.

The program id is machine-local. PREFLIGHT forbids a keypair file inside the repo, so
target/deploy/othello-keypair.json is generated per clone and gitignored. A clean
clone builds, exit 0, and prints "Program ID mismatch detected ... run `anchor keys
sync`"; that one command restores it, and PREFLIGHT already checks all three copies
before any deploy. The adversary verified the clean-clone build and did not treat the
mismatch as a defect.

Not done here, and deliberately: P1 chooses the clock-warp harness and reports the
result for OPEN-QUESTIONS line 1. This task only makes the probe it will call. Note
that OPEN-QUESTIONS asks for that decision to be recorded as ADR-011, but ADR-011 is
already Jupiter price units, so the number in that line is stale. The build does not
write ADRs.
