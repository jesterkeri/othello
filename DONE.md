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

## P1 - 2026-09-22
commit: 32b0bf5 (proof in 8bfe4a7, adversary fixes in 32b0bf5)
verified: `pnpm tsx tests/p1-harness-proof.ts`
output:
```
$ pnpm run test:p1
P1 harness proof: bankrun loads the real NFLXx mint and warps the Clock to an exact second
  harness built target/deploy/othello.so carries OTHELLO-HARNESS-BUILD-DO-NOT-DEPLOY
  program id    DhZhSvtTh78ZK26MkVVpyeDYr4MuyTZSVrT5YEFqqrDT
  mint loaded   XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL  680 bytes, owner Token-2022, base64 identical to the fixture
  clock         set to 1763337299, program returned 1763337299
  clock         set to 1763337300, program returned 1763337300
OK: bankrun loads the real NFLXx mint at its canonical address and places the Clock on
    1763337299 and 1763337300 exactly, with the T01 program reading each one back.
    No multiplier was decoded here; that is T03 and T06.
    (restored the default build in target/deploy/othello.so)
OK: a failed P1 run leaves the default build in target/deploy
exit=0

$ pnpm test
  4 passing (53ms)
OK: 11 binding-record cases, every field is load-bearing
OK: 15 cases, only a mint that proves its identity becomes a fixture

$ pnpm typecheck
> tsc --noEmit

typecheck exit=0
```
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: DEFECT fixed in 32b0bf5, attacks run: 9, test: tests/p1-restore-window.ts
notes: The harness is bankrun (`solana-bankrun` 0.4.0), and that was not the expected
answer. It loads the real NFLXx mint at XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL,
680 bytes read back out of the harness and base64-identical to tests/fixtures/NFLXx.json
with a Token-2022 owner, and places the Clock on 1763337299 and 1763337300 exactly, with
the program returning each second through transaction return data. Those are the second
before NFLXx's multiplier changes and the second it changes (SPEC 9b.1), so this is the
boundary T03, T04 and T06 all turn on. No multiplier is decoded and no valuation is
asserted here; that is T03 and T06. No ADR is written: OPEN-QUESTIONS line 1 carries the
finding for the design session, and repeats that the "ADR-011" in that line is stale
because ADR-011 is already Jupiter price units.

LiteSVM was tried first, since anchor-cli 1.1.2's own project template ships it in
dev-dependencies. In this repo's install it aborts the process with `std::bad_alloc`
shortly after the first transaction that invokes the loaded program.

ADVERSARY DEFECT 1, real, found on 8bfe4a7. `anchor build -- --features harness` ran at
module top level, outside the try/finally that restores the deployable build. Every
statement between the two could throw: the marker check, the IDL read and parse, the
read_clock assertion, the instruction encode and both fixture assertions. On any of
those paths the process exited leaving target/deploy/othello.so carrying the harness
probe, which turns `pnpm test` and `anchor test` red two steps away from whatever
actually failed. Fixed: the harness build and the fixture read are inside the try, and
SIGINT and SIGTERM restore as well, which a plain `finally` never did.

The adversary's test is integrated as tests/p1-restore-window.ts and passes on the gate
branch. Both directions were verified here rather than taken on trust: swapped in the
pre-fix proof from 8bfe4a7 and the test fails with `actual: true`, meaning the marker is
still in the binary; swapped the fix back and it prints OK. The test drives the exact
drift the proof's hardcoded NFLX_MINT constant exists to catch, by putting the repo's
own real AAPLx fixture into NFLXx.json, and it now also asserts the fixture came back
byte for byte.

ADVERSARY DEFECT 2, real, and the wrong claim was mine. tests/p1-harness-proof.ts and
8bfe4a7's message both said LiteSVM aborts "on the SECOND invocation of a loaded SBF
program" and offered that as the whole basis for the harness decision. The adversary ran
the same workload on 0.5.0, 0.7.0 and 0.8.0 in its own git worktree and it completed.
Neither result was taken on trust; the experiment was rebuilt in an isolated project
outside the repo:

```
$ node probe3.mjs        # 3 invocations, synchronous logging so the abort site is visible
call#1: sendTransaction / sent, reading returnData / -> 0
call#2: keypair
terminate called after throwing an instance of 'std::bad_alloc'

$ for i in 1..8: node probe3.mjs        survived 0/8 runs
$ 10 consecutive builtin system-transfer transactions in one instance    SURVIVED
```

The abort is real and deterministic here, but it lands on whatever allocates next:
Keypair.generate, setAccount and sendTransaction have each been the site across runs, so
"the second invocation" was never the mechanism. One identical probe run against both
installs settled it:

```
same script, same byte-identical native binary:
  litesvm resolved from the adversary worktree store: survived 5/5
  litesvm resolved from this probe's own store:        survived 0/5
md5 litesvm.linux-x64-gnu.node, both trees: bacf18e6cd02bf371b93a8ed4ceb03f7
```

So the abort is install-tree dependent and its cause is not established. The decision,
bankrun, is unchanged and is the right one: it ran this workload in every attempt. The
reason recorded for the ADR is now reliability observed here, not a proven LiteSVM
defect, because a design session reading the original wording would have written a false
limitation into the ADR.

`pnpm run test:p1` runs the proof and the regression test. It is deliberately NOT part of
`pnpm test`: each run drives two anchor builds, and `anchor test` is the inner loop for
T02 to T06.

Carried to T06: this proof drives the program by hand-encoding the instruction with
anchor's BorshInstructionCoder. `anchor-bankrun`, which would give T06 a full Anchor
Provider over bankrun, was installed, went unused and was removed rather than left as
dead wiring. T06 must confirm anchor-bankrun 0.5.0 against @coral-xyz/anchor 0.32.1, or
keep hand-encoding.

Also noted by the adversary and not a defect against the P1 contract, recorded because it
is worth someone's attention: the mint check is a round trip through one file, since
`dataBase64` is both what P1 writes and what it compares against. A fixture whose address
still reads XsEH7w... but whose bytes were altered would pass P1. Authenticity of those
bytes is T00's job and T00 proves it (tests/t00-*.ts, SPEC 9b.6), so P1 is within its
contract, but P1 alone is not evidence the bytes are NFLXx's.

## T02 - 2026-09-22
commit: 4a05888 (decoder in 3b1c74d, adversary fix in 4a05888)
verified: `cargo test -p othello decode`
output:
```
$ cargo test -p othello decode
running 9 tests
test valuation::tests::decode_accepts_the_largest_multiplier_that_still_fits ... ok
test valuation::tests::decode_agrees_with_an_independent_decimal_expansion ... ok
test valuation::tests::decode_floors_rather_than_rounds ... ok
test valuation::tests::decode_is_monotonic_across_the_usable_range ... ok
test valuation::tests::decode_is_not_a_float_multiply ... ok
test valuation::tests::decode_is_not_a_float_multiply_below_one ... ok
test valuation::tests::decode_matches_the_spec_vectors ... ok
test valuation::tests::decode_refuses_every_non_finite_pattern ... ok
test valuation::tests::decode_refuses_values_that_cannot_be_a_multiplier ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

$ cargo test -p othello        # whole crate
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

$ cargo fmt --check && cargo clippy --all-targets -- -D warnings
fmt clean
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.20s
$ anchor build
     Running unittests src/lib.rs (/home/hr/myvscode_linux/othello/target/debug/deps/othello-995034df92de9df1)
```
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: DEFECT fixed in 4a05888, attacks run: 9, test: programs/othello/src/valuation.rs (below-one vectors)
notes: `decode_multiplier_fixed(bits) -> floor(multiplier x 1e9)`, computed from the
IEEE-754 fields as integers. A binary64 is significand x 2^exponent with both integral,
so the floor is an exact shift of significand x 1e9 in u128. The value is never
materialised as a float; every f64 in valuation.rs sits inside `#[cfg(test)]`, which
satisfies AGENTS.md's "no floats in the program".

SPEC section 10's three vectors hold: 1.0026642075893797 -> 1002664207,
1.0032690125398187 -> 1003269012, 1.0000003 -> 1000000299. Measured against the four
real mints, a float multiply disagrees with the exact floor on five of the nine recorded
values. ADR-001's case is the one that survives truncation as well as rounding:
1.0000003_f64 * 1e9 is exactly 1000000300.0, so even a truncating cast reads 1000000300
where the floor is 1000000299.

Refusals: NaN, both infinities, anything negative including -0.0, anything that scales
past u64, and anything that floors to zero. Zero is refused rather than returned. A zero
multiplier is not "worth nothing", it is the mint failing to say what the asset is worth,
which SPEC section 9's error table calls asset ineligible. Every subnormal floors to zero
and is refused by the same route, which is the "subnormal edge handled as specified" that
SPEC section 10 asks for.

MUTATION CHECK. INVARIANTS names I5 as one that must be mutation-checked, so it was,
twice. First round, six mutants, one survivor. Second round after the adversary pass,
nine mutants, no survivors:

```
  KILLED   ceil below 1.0 (the adversary's M9)     5 passed; 4 failed
  KILLED   refuse every multiplier below 1.0       6 passed; 3 failed
  KILLED   narrow the small-value guard to 64 bits 6 passed; 3 failed
  KILLED   floor -> round                          4 passed; 5 failed
  KILLED   drop the implicit leading one           2 passed; 7 failed
  KILLED   exponent bias off by one                3 passed; 6 failed
  KILLED   drop the zero refusal                   8 passed; 1 failed
  KILLED   drop the sign refusal                   8 passed; 1 failed
  KILLED   drop the u64 overflow refusal           8 passed; 1 failed
  survivors: none
```

One equivalent survivor is known and kept: deleting the NaN/infinity branch leaves the
suite green, because every non-finite pattern has exponent field 0x7FF, which becomes a
2^972 shift that the u64 overflow guard refuses anyway with the same error. The adversary
confirmed the equivalence independently. The branch stays because it makes the refusal
say what it means and survives any later change to the output width, and the source says
so at the branch.

ADVERSARY DEFECT, real, found on 3b1c74d, against INVARIANTS:3. The decoder itself held
under a differential sweep of 309,612 bit patterns against exact rationals, in dev and in
release with overflow-checks on, with zero disagreements. The suite was the defect: every
accepted vector sat in [1.0, 10.0], so nothing pinned the floor below 1 and three
non-equivalent mutants passed all eight tests. The first of them, ceil below 1, is
ADR-001's own overvaluation defect mirrored, and it is not a hypothetical range: a
multiplier below 1 is what a reverse split writes, the mirror of the real NFLXx 10-for-1
the gate is built around. Direction matters here, because an overvalued FUND (SPEC
section 4) lets release_pot pass a coverage gate it should fail.

Fixed with six below-one vectors, computed on exact rationals rather than with this
decoder: 0.1 -> 100000000 where ceil would say 100000001, 0.001 -> 1000000, 1e-6 -> 999,
0.9999999999 -> 999999999, 0.5 -> 500000000, and 1e-9 -> 1, the smallest multiplier that
is not refused. 9.9e-10 joins the refusal list as the step below it. Both table-driven
tests now walk every vector, and ADR-001's anti-float case gained a below-one twin: the
double nearest 1e-6 is under it, but 1e-6_f64 * 1e9 is exactly 1000.0, so even a
truncating cast overvalues by a whole unit.

The adversary also raised one unproven suspicion that became load-bearing the moment 1e-6
was added: `decode_agrees_with_an_independent_decimal_expansion` cut `format!("{:.40}")`
at nine places, but that expansion is ROUNDED, so a run of nines past the cut carries into
digit 9 and accuses a correct decoder. 1e-6 has thirteen such nines. The reference now
formats to 1100 places, past where any binary64 expansion terminates, so the digits are
exact and the cut is sound. Caught before it could produce a false failure.

The adversary independently decoded the ScaledUiAmount extension (TLV type 25) straight
out of `dataBase64` in all four committed fixtures and confirmed all eight real bit
patterns and all eight expected integers in the test table match the mint bytes,
`decodedScaledUiAmountConfig`, and SPEC 9b.1. It also confirmed
`u32::from(OthelloError::MultiplierInvalid) == 6000` and that the message matches SPEC
section 9's copy verbatim.

Errors are append-only. Anchor numbers variants by declaration order and that number goes
on chain, so inserting one silently renumbers every code after it; each task appends the
codes it implements.

Carried to T03: this function takes raw u64 bits rather than a PodF64, so it stays
independent of the Token-2022 layout. T03 reads the bits out of ScaledUiAmountConfig and
passes them in.

## T03 - 2026-09-22
commit: bb5bc5a (reader in 118ba66, adversary fixes in bb5bc5a)
verified: `anchor test`
output:
```
$ anchor test
running 20 tests
test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
    ✔ greps for a marker the program actually declares
    ✔ keeps the harness probe out of the deployable program binary
    ✔ declares one program id in lib.rs, Anchor.toml and the built IDL
    ✔ loads the built IDL into the TypeScript client (40ms)
    ✔ keeps the manifests saying the things the program depends on
    ✔ keeps the harness probe out of the default build's IDL
  6 passing (49ms)
OK: 11 binding-record cases, every field is load-bearing
OK: 15 cases, only a mint that proves its identity becomes a fixture

$ cargo fmt --check; cargo clippy --all-targets -- -D warnings; pnpm typecheck
fmt clean
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.30s
```
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: DEFECT fixed in bb5bc5a, attacks run: 13, test: programs/othello/src/valuation.rs (t03_both_readers_agree_on_a_mint_with_an_uninitialized_tlv_entry)
notes: `effective_multiplier_fixed(mint_data, unix_timestamp)` unpacks the mint with
Token-2022's own StateWithExtensions, takes the scaled-UI extension, selects `multiplier`
or `new_multiplier` on the Clock, and hands raw bits to T02's decoder. Token-2022's
`current_multiplier` is private and returns f64, so the selection is reimplemented on
bits and the value is never a float. The boundary is inclusive, byte for byte the rule in
the library.

Both parsers agree on AAPLx, NFLXx, SPYx and NVDAx, field by field, and a third parse
agrees too: the values ops/fetch-fixtures.ts recorded in each fixture's
decodedScaledUiAmountConfig, compared on bits rather than on decimal text. That is a
third parse of the same bytes, not a third source of truth, and is recorded as such.

SPEC section 10's clock cases hold on the real bytes: NFLXx 1000000000 at 1763337299 and
10000000000 at 1763337300; AAPLx 1002664207 at 1786148999 and 1003269012 at 1786149000.
Every fixture is also checked at both sides of its own boundary, and all four have
multiplier != new_multiplier, so that test is not vacuous.

ADVERSARY DEFECT 1, real, found on 118ba66, and it hollowed out the point of the task.
tlv_fallback::find did not implement Token-2022's rule that the TLV walk stops at an
Uninitialized entry, so on a mint carrying one the program refused the mint while the
reader that exists to corroborate the program reported a multiplier. 28 single-byte
overwrites of the real AAPLx fixture diverge this way. Always in the safe direction and
never wrong money, but the cross-check TASKS T03 asks for was thinner than it read.

Worse: three mutants survived the whole suite, and the load-bearing one was replacing the
byte reader's body with a call to StateWithExtensions. Nothing in the suite could tell a
second reader from a wrapper around the first, which is precisely the property being
claimed as evidence.

Fixed, and now pinned. The adversary's test is integrated verbatim. A second test builds
a TLV buffer by hand with a distinct sentinel in every field, on a mint base Token-2022
refuses as uninitialised: the official parser cannot answer there, so a delegating
implementation fails, and field order is covered independently of the fixtures. A third
covers the account-type and declared-length refusals.

MUTATION CHECK, second round, all killed:
```
  KILLED   M7  byte reader delegates to the official parser   19 passed; 1 failed
  KILLED   M8  drop the account-type check                    19 passed; 1 failed
  KILLED   M9  drop the declared-length check                 19 passed; 1 failed
  KILLED   M13 drop the Uninitialized stop                    19 passed; 1 failed
  KILLED   M14 swap the authority and multiplier slots        18 passed; 2 failed
  survivors: none
```
The adversary's own first round had killed M1 to M6 and M10 to M12: the boundary flipped
four ways, the hardcoded type and length changed, header-skipping, the timestamp read
from the wrong slot, and assuming 1.0 when the extension is absent.

ADVERSARY DEFECT 2, real, and the first fix for it was wrong. The freshness guard omitted
the workspace Cargo.toml, rust-toolchain.toml and Anchor.toml, so both artifact guards
would certify a binary older than three of its inputs. Adding them to the mtime list broke
worse: cargo skips relinking when content has not changed, so a manifest whose mtime moved
without its content moving leaves the artifact permanently stale and no rebuild clears it.
That failure mode was reproduced here, not assumed. An unclearable guard is worse than
none, so the manifests are guarded on content instead: default features stay empty, the
harness feature exists and is opt-in, overflow-checks stays on, resolver 2 keeps
dev-dependency features out of the program, and the toolchain pins an exact compiler. That
guard needs no build at all and catches the real failure, the harness feature reaching
default, at the source rather than in bytes that may not have been rebuilt. Confirmed by
setting default = ["harness"], which fails five tests. The mtime guard keeps the .rs
sources, where a content change does force a relink.

Also fixed, from an unproven suspicion that was correct: both P1 scripts called an
asserting anchorBuild inside a `finally`, and a throw there replaces the error already
propagating, losing the finding the script exists to report. Both now catch and print.

Attacks that found nothing, worth recording because they are the ones a reviewer will
ask about: the boundary at i64::MIN and i64::MAX and on negative timestamps; floats on the
program path (`PodF64.0` is read as [u8; 8] and nothing calls `From<PodF64> for f64`);
dev-dependencies reaching the program (`resolver = "2"`); overflow, wrap or out-of-bounds
reads in the byte reader (`entry_len` is u16 and every read is `data.get(..)?`); duplicate,
overlong, truncated and wrongly-typed TLV entries; 3,108 hostile single-byte overwrites
through effective_multiplier_fixed with zero panics and zero cases where both readers
succeed with different multiplier bits.

Carried forward: anchor-bankrun 0.5.0 does drive @coral-xyz/anchor 0.32.1 over bankrun,
settled by spike rather than left for T06 as P1's entry said. `program.methods.readClock()`
over a BankrunProvider returns a signature. T04 onwards can use real Anchor calls instead
of hand-encoded instruction data.

One divergence between the two readers is known and left: Token-2022 refuses a buffer of
exactly Multisig::LEN and the byte reader does not model that rule. Unreachable on a mint
Token-2022 wrote, since it pads around that length, and the divergence is in the safe
direction.

## T04 - 2026-09-22
commit: d14e2fb
verified: `anchor test`
output: see the T06 entry below; that run covers T04, T05 and T06 together, since
they share one suite and one branch.
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: running at time of writing on d14e2fb; result appended when it reports
notes: init_price_feed, set_prices and touch_prices. Othello reads no oracle, so the
program's whole job here is that a price can never be bound to the wrong multiplier.

D5 is two checks, not one. set_prices recomputes from the mint's own bytes what the given
stamp WOULD bind and refuses unless it equals expected_multiplier_fixed, so the script
names the multiplier its prices were quoted for and the program verifies rather than
guesses. Separately a Current stamp is refused while a Scheduled one is still pending,
which is the case SPEC section 10 names: putting the old share price back as Current
before the split lands would value the collateral at a tenth. touch_prices moves
updated_at and nothing else, which is why the refresh script can keep a demo alive
without ever re-binding a price. Both halves of I17 are covered.

Tests are real Anchor calls against bankrun with the REAL NFLXx mint at its real mainnet
address, so the multiplier the program stamps comes from mainnet bytes rather than from
anything the test invented.

tests/harness.ts is shared with T05 and T06. It also resolves refusal codes through the
BUILT IDL rather than a hand-written table, because bankrun's processTransaction throws a
raw `custom program error: 0x1773` where .rpc() throws a decoded AnchorError. A renamed or
renumbered refusal now fails a test instead of passing silently.

`BN` is not reachable as a named ESM export from @coral-xyz/anchor, only on the CJS
default, because it is re-exported from bn.js. Reaching it through the default beats
adding bn.js as a direct dependency it is not.

## T05 - 2026-09-22
commit: 06bf98f
verified: `anchor test`
output: see the T06 entry below.
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: pending (queued behind the T04 pass on the shared suite)
notes: FUND, EXEC and H from SPEC section 4, u128 and checked throughout, returned as
Anchor return data. FUND is the position at the share price through the multiplier; EXEC
is the position at the wrapper price, which is what someone would actually pay for the raw
token. They disagree while a split is being priced and SPEC counts the lower, which is why
a multiplier alone can never inflate collateral past what the raw token would fetch.

I12 HOLDS, on the real NFLXx mint, and this is the gate's go/no-go: 1.1 token at wrapper
150 and share 150 before the split, wrapper 150 and share 15 after, haircut 2000. H is
132 USDC on both sides, to the base unit, across a real 10-for-1. A reader that ignores
the multiplier reads the same position's FUND as 16.5 USDC instead of 165, and the suite
asserts that factor of ten explicitly rather than describing it.

I13 holds: while the feed's stamp and the effective multiplier disagree, the position is
Repricing and the quote refuses rather than returning a number wrong by the size of the
split.

CU: quote_valuation costs 4842 against the 200k default, recorded for SPEC section 10.
The figure moves by a few dozen between runs with the account set; it is nowhere near the
limit.

Also covered: an unpriced feed and a price one second past max_price_age both refuse; the
haircut floors, so a 1-raw-unit position counts as 0 rather than rounding up; u64::MAX raw
refuses with ValuationOverflow rather than wrapping.

SPEC:112 writes the signature as quote_valuation(raw) with accounts mint and feed, but h
is defined in terms of haircut_bps and price_stale in terms of max_price_age, and neither
is reachable from a mint or a feed: both live on Circle. The pack under-lists argument
lists elsewhere too (TASKS:13 writes set_prices(stamp, expected_multiplier_fixed) where
SPEC:113 has four), so this reads it as under-listing, keeps the accounts exactly as SPEC
states, and records the reading in OPEN-QUESTIONS for the design session.

## T06 - 2026-09-22
commit: see below
verified: `anchor test`
output:
```
$ anchor test
running 22 tests
test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
    ✔ greps for a marker the program actually declares
    ✔ keeps the harness probe out of the deployable program binary
    ✔ starts unpriced, bound to its own mint
    ✔ stamps Current with the multiplier in force, read from the real mint
    ✔ stamps Scheduled with the multiplier that is coming, not the one in force
    ✔ refuses prices whose named multiplier is not the one the stamp would write
    ✔ refuses a Current stamp while a Scheduled stamp is still pending
    ✔ accepts a Current stamp once the split second has arrived
    ✔ touch_prices moves only updated_at
    ✔ refuses a zero price
    ✔ refuses both admin instructions from a wallet that is not the authority
    ✔ values the demo position before the split
    ✔ I12: H is unchanged across the split, to the base unit
    ✔ is worth ten times what a reader that ignores the multiplier would say
    ✔ I13: refuses while the stamp and the effective multiplier disagree
    ✔ refuses a price older than max_price_age, and an unpriced feed
    ✔ counts the lower of FUND and EXEC, and floors the haircut
    ✔ refuses a position too large to value, rather than wrapping
    ✔ refuses a haircut of 100% or more, and a non-positive max age
      quote_valuation compute units: 4842
    ✔ records the compute units SPEC section 10 asks for
    ✔ values all four real mints, at their real mainnet addresses (95ms)
    ✔ refuses a byte-perfect copy of a real xStock at an unvetted address
    ✔ still refuses at quote time, even if a feed for an unvetted mint existed
    ✔ keeps the program allowlist and ops/xstock-mints.ts in step
    ✔ every allowlisted mint has a committed fixture, and vice versa
    ✔ declares one program id in lib.rs, Anchor.toml and the built IDL
    ✔ loads the built IDL into the TypeScript client
    ✔ keeps the manifests saying the things the program depends on
    ✔ keeps the harness probe out of the default build's IDL
  29 passing (8s)
OK: 11 binding-record cases, every field is load-bearing
OK: 15 cases, only a mint that proves its identity becomes a fixture

$ cargo fmt --check; cargo clippy --all-targets -- -D warnings; pnpm typecheck
fmt clean
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.77s
```
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: pending (queued behind the T04 pass on the shared suite)
notes: The ADR-012 allowlist, hardcoded rather than admin-managed, per the ADR and
OPEN-QUESTIONS. An admin-managed list would be one more thing the demo admin key could do,
and SPEC's threat model accepts that key only for prices and the pool.

Enforced at both points a mint enters the program: init_price_feed, because a feed is
where a mint first appears, and quote_valuation again, because quoting a value for a mint
Othello would not accept as collateral says it is acceptable collateral. The second check
is unreachable through normal instructions, so the test writes a feed account directly
into the harness to exercise it: defence in depth is only worth having if it is exercised.

THE CASE THAT MATTERS is not a malformed mint, it is a perfect one. The test copies NFLXx's
real bytes to an address nobody vetted, asserts the two accounts are byte-identical, and
shows the program refuses it. Nothing on-chain distinguishes them (SPEC 9b.6): same
authorities, same metadata, same multiplier. Only the address does. That is ADR-012's
whole claim, demonstrated rather than asserted.

All four real mints are valued at their real mainnet addresses, with the multiplier
checked against what the T00 fetcher recorded in each fixture rather than against a
hand-written expectation.

One assertion in that test was wrong before it was right, and the program was correct:
with share = wrapper, any mint whose multiplier is above 1 has FUND above EXEC, so H comes
off EXEC. AAPLx caught it at 1.0026642075893797. The test now asserts min(FUND, EXEC)
explicitly and that EXEC is the lower, which documents the behaviour instead of hiding it.

A drift guard compares the four addresses in programs/othello/src/allowlist.rs against
ops/xstock-mints.ts and against the fixtures, because the same four addresses now live in
three places and nothing else would stop them diverging.

Branch note: T04, T05 and T06 share the branch task/T04 and one test suite. That departs
from one-branch-per-task. They are a single sequence against one shared harness and the
deadline is Friday; recorded here rather than left implicit.

## R1 - 2026-09-22
commit: see below
verified: `cargo clippy --all-targets -- -D warnings && cargo fmt --check && anchor test`
output:
```
$ cargo clippy --all-targets -- -D warnings && cargo fmt --check && anchor test
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.09s
fmt: clean
running 22 tests
test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
      quote_valuation compute units: 4789
    ✔ records the compute units SPEC section 10 asks for
  31 passing (6s)
OK: 11 binding-record cases, every field is load-bearing
OK: 15 cases, only a mint that proves its identity becomes a fixture

$ git diff --stat ac067bc  # R1 before/after
 programs/othello/src/instructions/price_feed.rs |  22 +---
 programs/othello/src/instructions/quote.rs      |  74 +++----------
 programs/othello/src/valuation.rs               |  89 ++++++++++++++--
 tests/harness.ts                                | 135 +++++++++++++++++++++++-
 tests/t04-price-feed-repricing.spec.ts          |  58 +++-------
 tests/t04-price-feed.spec.ts                    |  58 +++-------
 tests/t05-quote-valuation.spec.ts               |  67 ++++--------
 tests/t06-allowlist.spec.ts                     |  46 +++-----
 8 files changed, 302 insertions(+), 247 deletions(-)
```
reviewed: n/a (covered by Codex Gate 1 review at T07)
adversary: n/a (no behaviour changed; the same 22 Rust and 31 mocha tests pass before and
after, and the pass is verified by that rather than by a new attack)
refactor: 4 applied, 1 declined in part

APPLIED 1. The Token-2022 unpack + `get_extension` pair was written five times. Extracted
as `valuation::scaled_ui_config`, which `effective_multiplier_fixed`, both `price_feed`
helpers and the quote now share. Down to two occurrences: the extraction itself, and the
test module's own copy, which is deliberately the official parser used as the comparison
baseline for the byte reader.

APPLIED 2, and this is the one that matters for gate 2. The freshness check, the D5 stamp
check and the FUND/EXEC/H sequence moved out of `quote_valuation` into
`valuation::value_position`. I13 requires exactly that sequence in `join_and_lock`,
`release_pot` and `update_coverage`, so leaving it in the instruction would have meant
copying it three more times in T09 to T11, with three more chances to get the refusal
order wrong. The order is asserted by the T05 suite and did not move:
`InvalidParams`, `MintNotAllowed`, `PriceStale`, `MultiplierPriceMismatch`.

APPLIED 3. The TypeScript specs had four copies of the `BN` interop shim, the split
constants, the price-setting helpers and the return-data decoder, and they had already
drifted: two shims typed their argument `number` and two `number | string`, and t05
asserted the 32-byte return-data length that t06 omitted. All hoisted into
`tests/harness.ts`. Sharing the decoder gives t06 that length assertion, so this pass made
one test stricter rather than looser. Each spec's own variation stayed a parameter: the
signer, the mint, the prices, the stamp and the quote's arguments.

APPLIED 5. Dropped an unused import, and named two bare SPEC §4 denominators in files that
already named their others: `100_000_000n` became `RAW_PER_TOKEN` and `8000n` became
`10_000 - HAIRCUT_BPS`, same integer result, floor division unchanged.

DECLINED IN PART, 4. Hoisting the repeated test constants was applied: `SCALED_UI_HEADER`
is declared once and the plain-mint length 82 is named. But the proposal also asked the
tests to reuse `tlv_fallback`'s own `ACCOUNT_TYPE_INDEX`, `TLV_START` and
`ACCOUNT_TYPE_MINT` instead of the literals 165, 166 and 1. Declined: a hand-built buffer
that uses the reader's own constants is built wrong and read wrong together, so it would
agree with a broken reader. That is exactly the independence the byte reader exists for,
and it has to reach the test data too. The literals stay, with a comment saying why.

NOT FIXED, recorded instead. The refactor pass raised one unproven suspicion:
`value_position` computes `age = now - feed.updated_at` and a feed stamped ahead of the
clock gives a negative age, which passes the freshness check. R1 must not change
behaviour, so it is in OPEN-QUESTIONS for the design session rather than patched here.
Both writers of that field write `Clock::get()`, so it needs the validator clock to move
backwards.

Nothing was weakened, skipped or deleted. Test counts are identical either side of the
pass: 22 Rust, 31 mocha, 26 T00 cases.

## T07 - 2026-09-22
commit: b7c68df (reviewed), fixes in the commit below
verified: `./scripts/check-reviews.sh`
output:
```
$ ./scripts/check-reviews.sh
reviews ok

$ head -1 reviews/gate-1-review.md
VERDICT: implementation-ready

$ git diff --ignore-blank-lines --stat b7c68df..HEAD -- programs ops tests scripts .github
(empty)
```
reviewed: reviews/gate-1-review.md | verdict: implementation-ready | commit: b7c68df | C0 M0 m2 (both OUTSIDE)
adversary: n/a (T07 produces a document; the code it describes was adversarially reviewed at T00 to T06)
notes: GATE 1 PASSES. Codex returned implementation-ready with two MINORs, both marked
OUTSIDE the review's stated concerns, neither touching the program.

Both were real and both are fixed. The first was an error in my own brief: it said
`pnpm run test:t00` reaches mainnet RPC and assets.backed.fi. It reaches nothing. The
suite serves JSON-RPC and the issuer's product pages from a localhost server and runs the
fetcher against it with OTHELLO_INSECURE_TEST_RPC=1
(tests/t00-mint-symbol-verification.ts:155,172-174, verified before correcting rather than
taken on trust). The live command is ops/fetch-fixtures.ts, which rewrites tests/fixtures/.
Section 5 of the brief repeated the same mistake while listing where the tests are thin,
so a stated weakness was not a weakness. Both corrected. The second was a blank line at
EOF in tests/harness.ts, deleted.

INDEPENDENT CONFIRMATION, worth more than either finding: the reviewer fetched current
mainnet data into an isolated directory and found all four scaled-UI configurations match
the committed fixtures, with only the mutable supply bytes differing. That is T00's
provenance chain checked by a second party against the live chain. No test in this repo
does that, because the suite is offline by design, so this is the only end-to-end
confirmation the fixtures are still what they claim to be.

WHAT THE REVIEWER DID NOT DO, from its own U8: it did not deploy to a cluster, did not
test the known init_price_feed takeover, and did not rerun the mutation campaigns
independently. It also recorded that a single-prompt review is not blind under U1. Those
are limits on this verdict and are recorded here rather than left in the terminal.

GATE 1 IS LOCALLY IMPLEMENTATION-READY AND NOT DEPLOY-READY. The init_price_feed
oracle-takeover block in OPEN-QUESTIONS stands until T23 and this verdict does not clear
it; the brief said so in section 7 item 1 and the review repeats it.

OPEN, for Joshua: REVIEWS.md says a fix after a review is the newest code and therefore
the most suspect, and should be re-reviewed. The code change after the reviewed SHA is one
blank line, and `git diff --ignore-blank-lines` over programs, ops, tests, scripts and
.github is empty; everything else is documentation. Whether that earns a re-review round
is his call, not the builder's, so it is recorded rather than waived.

## T08 - 2026-09-23

reviewed: n/a (covered by the Gate 2 Codex review at T13)
adversary: NO DEFECT FOUND in this pass, attacks run: 0 this session, test: tests/t08-create-circle.spec.ts. The code and its spec were written and merged to staging earlier; this entry records the evidence that was owed and never pasted

Recorded late. create_circle.rs and tests/t08-create-circle.spec.ts reached
staging without a DONE.md entry and with the task still unchecked, which is
exactly the state guard-done.sh exists to catch and did not, because the task
was never ticked. Found while answering "are we using a contract for our build".

verify: `anchor test`

  T08 create_circle
    ✔ creates the demo circle in Forming, with everything zeroed
    ✔ refuses g = 29 and accepts g = 30, which is the peak exactly
    ✔ the peak it enforces is SPEC's 150, not a rounder number
    ✔ refuses every parameter range separately (84ms)
    ✔ refuses a member list that is the wrong size, or has a duplicate, or
      omits the creator
    ✔ refuses a byte-perfect counterfeit even when a feed for it already exists

  37 passing (7s)

done when: demo params pass, g=29 refused with guarantee_below_peak_need, each
range refused. All three are covered by the six tests above, and the peak is
pinned at SPEC's 150 rather than at a round number, so a mutant that computed a
different peak and still refused 29 would not survive.

KNOWN AND CARRIED FORWARD: the vaults are deliberately not created here.
InitializeAccount3 on a mint carrying a permanent delegate returns
InvalidAccountData, because a Token-2022 account for an extension-carrying mint
needs more than 165 bytes. That is KNOWN-LIMITS L7 confirmed on chain rather
than assumed. Vault creation moves to T09, which has to solve the sizing either
extension-aware or through the ATA program.

## T09 - 2026-09-23

reviewed: n/a (covered by the Gate 2 Codex review at T13)
adversary: not run yet, attacks run: 0, test: tests/t09-join-and-lock.spec.ts. To run before T13

join_and_lock, cancel_circle and activate. The Member account arrives with them,
laid out exactly as SPEC §4 specifies it.

verify: `anchor test`

  T09 join_and_lock, cancel_circle, activate
    ✔ creates the circle's Token-2022 vault that T08 could not, and locks into it
    ✔ records the seat the CREATOR fixed, not one the joiner chose
    ✔ I4: the stock vault equals the sum of member.stock_raw, member by member
    ✔ refuses a wallet the creator never named
    ✔ refuses stock worth less cover than the minimum, at the exact boundary
    ✔ refuses a wallet that does not hold the stock or the guarantee
    ✔ refuses a second join from the same wallet
    ✔ refuses joining a circle that is no longer Forming
    ✔ activate refuses until every seat has joined, then sets round 0 and the deadline
    ✔ activate and cancel are the creator's alone
    ✔ cancel_circle moves a Forming circle to Cancelled and refuses twice
    ✔ cannot activate a cancelled circle

  49 passing (10s)

  cargo clippy --all-targets -- -D warnings: clean
  cargo fmt --check: clean

done when: refusal codes tested; I4 holds. Covered here: not_a_member,
circle_not_forming, collateral_below_minimum, insufficient_balance and
not_all_joined, plus Unauthorized on the two creator-only instructions.

CORRECTION, 2026-09-23. This entry first claimed "Every code SPEC §5 names for
these three is covered" and then listed five. SPEC.md:102 names SEVEN for
join_and_lock: price_stale, multiplier_price_mismatch and multiplier_invalid
had no test. The behaviour was right, the claim was not, and TASKS.md:50's
done-when is "refusal codes tested". The first two are now covered by the
adversary's suite; multiplier_invalid is unreachable through an allowlisted
mint, so it is stated as unreachable rather than left implied. I4 is checked incrementally,
member by member, with each member locking a DIFFERENT amount, so a vault that
tracked a count or the last value rather than the sum would diverge on the
second join.

THE VAULT PROBLEM FROM T08 IS SOLVED. Anchor's `init` allocates a token
account's base 165 bytes, which a Token-2022 account for an extension-carrying
mint cannot use, and that is why create_circle could not make the vaults. Every
token account here is an Associated Token Account instead, so the length is
computed by the program that knows the answer. The first test asserts the vault
does not exist before the first join and holds the stock after it, against the
real NFLXx bytes at the real mainnet address, so the sizing is proved rather
than asserted.

This required `anchor-lang`'s `init-if-needed` feature. Its documented danger is
re-initialisation resetting a program-owned account's state; every use here is
an ATA, whose address is derived from (mint, authority) and which Anchor
validates rather than rewrites when it already exists. No Othello state account
uses it. The Member PDA uses plain `init`, which is what makes a second join
impossible.

TWO FINDINGS ABOUT THE REAL MINTS, both now in OPEN-QUESTIONS.

The real xStocks carry TransferHook, Pausable, DefaultAccountState,
PermanentDelegate and ConfidentialTransferMint as well as ScaledUiAmountConfig.
None blocks Othello today, and only because of three values the issuer controls:
the hook program id is all zeroes, paused is 0, and the default account state is
thawed. A plain transfer_checked is correct only while that holds.

And bankrun's bundled Token-2022 cannot parse those mints at all. It predates
extensions 25 and 26, and its TLV walk errors on an unknown discriminant, so
GetAccountDataSize returns InvalidAccountData and no ATA can be created. Proved
with a probe in the same harness run: a bare Token-2022 mint got an ATA, NFLXx
did not. tests/fixtures/spl_token_2022.so is the real program, dumped from
devnet, loaded by the harness. Without it these twelve tests cannot run, and the
failure would read like a defect in Othello rather than in the toolchain.

NOT DONE: the adversary has not attacked this yet. It has found a real defect in
every task it has been run on, so this is a gap and not a clean bill. Before
T13.

## T09 adversary - 2026-09-23

reviewed: n/a (covered by the Gate 2 Codex review at T13)
adversary: NO DEFECT FOUND, attacks run: 23, test: tests/t09-adversary.spec.ts (integrated, 5 cases, passing)

The adversary ran 23 attacks against the T09 diff with the spec and no access
to the reasoning behind the code, and broke none of them. Its report is
summarised here rather than pasted: seats and authority (6), account
substitution (6), price and time against I13 (4), accounting, ordering and
arithmetic (7).

Two it ran that this build had not thought to: `join` then `cancel_circle` then
`join` inside ONE transaction, refused 0x1779 on the third instruction; and
reserve_total overflow with g = 2^63 over three seats, where the second join
reverts whole on checked_add rather than wrapping. It also measured compute:
100,351 CU for the first join, which creates the Member PDA and both vaults
against the real NFLXx bytes, and 48k-60k after. Inside the 200k default, so no
ComputeBudget instruction is owed.

Its test is integrated and passes on this branch, `anchor test` 54 passing, up
from 49. It closes the three uncovered refusal codes noted in the correction
above, pins freshness as `<=` at the exact boundary second, and pins activate's
full-bitmap arithmetic at n=3 and at n=8, which is the `1u8 << n` overflow
branch the T09 suite never reached.

FOUR OBSERVATIONS, all acted on.

1. `AlreadyJoined` was unreachable and its comment said the opposite. Anchor
   runs `init` during account validation, before the handler body, so a second
   join never reached the bitmap check: it returns the System program's failure
   to allocate a non-empty account, measured as "unmapped custom program error
   0", never 6013. The comment claimed the check existed to give that failure
   SPEC's code. It did not and could not. Check deleted, comment replaced with
   what actually stops a second join, and the `AlreadyJoined` variant removed:
   it was last in the enum, so nothing renumbered, and SPEC §5 names no
   `already_joined` code for any instruction. An unreachable guard reads like a
   live one to the next person.

2. The coverage claim above, corrected in place rather than quietly amended.

3. `tests/harness.ts` still exported `vaultAddress()`, deriving the abandoned
   `["stock_vault", circle]` PDA from the T08 design. No callers, and now wrong,
   because the vaults are ATAs. A future test reaching for it would have
   asserted against an address that can never hold anything and passed
   vacuously. Deleted.

4. I4 cannot hold as a literal equality now the vault is an ATA, since anyone
   can transfer into one. Measured: 12,345 raw units sent in, then a join of
   110,000,000, vault reads 110,012,345 against a member sum of 110,000,000.
   INVARIANTS.md is the design session's file, so this is recorded in
   OPEN-QUESTIONS for a wording fix (`>=`, or "(+ dust)" as I3 already carries)
   rather than edited here. The program reasons from member.stock_raw and never
   from the vault balance, so no code changes either way.

AND ONE SUSPICION, unproven, recorded in OPEN-QUESTIONS for T14: `create_circle`
allowlists `stock_mint` but places no constraint on `usdc_mint` beyond the pool
PDA's seeds. A Token-2022 "USDC" carrying TransferFeeConfig would have
join_and_lock credit `reserve_total += g` while the vault receives `g - fee`,
so the reserve would exceed the money behind it. Admin-only and unwritten
today; the check belongs in T14.

Nothing the adversary wrote touched production code and it committed nothing.

## T09 early structural review - 2026-09-23

reviewed: reviews/gate-2a-t09-early-findings.md | EARLY FINDINGS, not a gate verdict | commit: 9ffe86c
adversary: NO DEFECT FOUND earlier in the day, attacks run: 23, test: tests/t09-adversary.spec.ts

Run on Codex's own advice, against Codex's own three guardrails: the exact
commit only, recorded as EARLY FINDINGS and never a verdict, and invalidated by
any later commit. T13 still gets the full gate 2 review of the accumulated diff.

TWO MAJOR FINDINGS, both accepted, both fixed in create_circle.

1. n x guarantee_per_member is compared against the peak in u128, but
   reserve_total, deposits_total and the USDC vault's amount are all u64. A
   guarantee of 2^63 over three seats passes the peak check, takes the first
   member's stock and guarantee, and then refuses every later join for ever.
   The circle can never reach Active and the money is only recoverable through
   a creator cancellation.

   Now refused at creation: `guarantee_per_member <= u64::MAX / n`.

2. round_secs has a floor of 60 and no ceiling. i64::MAX passes creation,
   accepts every join, and then fails inside `activate` on
   `now + round_secs`, with all five members' stock already locked. The
   documented activation surface promises only `not_all_joined`; a late
   parameter refusal after deposits is not in it. grace_secs has the same
   shape, and T15 will form `deadline + grace_secs`.

   Now refused at creation: `round_secs + grace_secs <= i64::MAX / 2`, which is
   the weakest condition under which the addition cannot overflow for any
   timestamp in the lower half of the range. That is a representability bound
   and not a maximum round length: a real maximum is a design decision and is
   recorded in OPEN-QUESTIONS rather than invented here.

WORTH RECORDING, BECAUSE IT IS A LESSON ABOUT THE REVIEW CHAIN. The adversary
found the first one's BEHAVIOUR this morning and passed it. Its attack 19 reads:
"reserve_total overflow: g = 2^63, three seats. First join books 2^63, second
refuses on checked_add and reverts whole. No wrap." Same input, same
observation, opposite conclusion. It asked "does this corrupt state" and
answered no. Codex asked "what is this circle now" and answered: bricked, with
someone's money in it. The absence of an overflow is not the absence of a
defect, and an adversary that only looks for corruption will hand back a clean
report on a trap.

Both tests assert the refusal happens AT CREATION, not on a later join, which
is the whole point: the old behaviour also "failed", just after someone had
paid. Mutation-checked, both bounds removed together:

  1) refuses parameters that make a circle unable to ever complete
     Error: expected the instruction to be refused, but it succeeded

The boundary is pinned accepted as well as refused, so the comparison is `<=`
and not `<`.

Codex found NO finding in the three structural decisions the review existed to
check: the ATA constraints bind each token account to the right mint, authority
and token program; the two CPIs are transaction-atomic and the direct mint-data
borrow ends before either; the n == 8 bitmap branch correctly avoids 1u8 << 8.
That is what the early review was for, and it came back clean.

verify: `anchor test` 55 passing, up from 54. clippy and fmt clean.

Its U8, not checked: no cluster transaction; it did not execute a bespoke
overflow reproduction, both sequences are read from the checked u64 paths; T10
to T12 are unwritten and unreviewed; the issuer-controlled extensions and the
init_price_feed takeover were not re-reviewed and remain open.

## T10 - 2026-09-23

reviewed: n/a (covered by the Gate 2 Codex review at T13)
adversary: not run yet, attacks run: 0, test: tests/t10-contribute-release.spec.ts. Before T13, and see the brief note below

contribute and release_pot, with the payout gate. The gate arithmetic lives in
programs/othello/src/gate.rs so T11's update_coverage and T15's declare_default
use one implementation: three copies of a rounding rule is three chances for one
of them to round the protocol's way.

verify: `anchor test`

  running 37 tests (Rust)
  test result: ok. 37 passed; 0 failed

  T10 contribute and release_pot
    ✔ contribute takes exactly the contribution and sets only that seat's bit
    ✔ contribute refuses twice, and refuses a circle that is not Active
    ✔ I6: the pot is refused until every seat has paid
    ✔ I1 and I18: a healthy demo round pays the pot and leaves nothing Paused
    ✔ I10: exactly n payouts, each seat once, then Completed
    ✔ I1: a price fall takes the gate below the line, and it refuses with the numbers
    ✔ the same fall later refuses as Paused instead, because the stock is no
      longer the whole gap
    ✔ refuses member accounts that are not this circle's seats in order
    ✔ refuses paying anyone but the seat whose turn it is

  64 passing (14s)

  cargo clippy --all-targets -- -D warnings: clean
  cargo fmt --check: clean

done when: I1, I6, I10 green; SPEC's table reproduced; no Paused after healthy
payouts (I18). All four.

SPEC'S TABLE IS REPRODUCED IN RUST, in gate.rs's own unit tests, not in the
integration suite. The table is arithmetic and belongs where the arithmetic is,
where it can be asserted without a validator:

  test gate::tests::the_gate_reproduces_the_spec_demo_table ... ok

It asserts need_k for k = 1..4 equals 140, 150, 30, 0, which is SPEC.md:133
verbatim. That matters because create_circle's peak check and release_pot's gate
are two implementations of the same table: if they disagreed, a circle could
pass creation and then pause on its own parameters.

I10 is checked by walking all five rounds and asserting the received bitmap
after each: 0b00001, 0b00011, 0b00111, 0b01111, 0b11111. One new bit per round,
in turn order, then Completed, then a sixth payout refused.

WHAT THE FIRST ATTEMPT AT THE REFUSAL TEST TAUGHT. I tried to build a circle
whose reserve could not meet its coverage target, and create_circle refused it
with GuaranteeBelowPeakNeed before the gate could run. That is KNOWN-LIMITS L4
demonstrated rather than quoted: "create-time peak check makes it unreachable
without a default or price fall". So in gate 2, before defaults exist at T15,
the ONLY honest way to reach a failing gate is a price fall under a circle that
was correctly created. Both refusal tests now do that.

The second one also corrected an expectation of mine rather than the code. I
expected ReserveOvercommitted at 50 a token; the program said CoverageTooLow and
was right. At 50, H is 44, each need is 151 and others_need is 151, which still
fits the 175 reserve, so the recipient's own stock IS the whole gap and "lock
more stock" is advice that would work. Only at 20 a token does others_need reach
178 and exceed the reserve, which is the branch where locking more stock would
not help. The SPEC's conjunction is doing real work and I had not believed it.

NOT DONE: the adversary has not attacked this. Given what it taught on T09,
where it found the g = 2^63 behaviour and passed it as "no wrap" while Codex
called the same circle bricked, its brief for T10 will ask what the CIRCLE is
after each attack, not only whether state is corrupted.

## T11 - 2026-09-23

reviewed: n/a (covered by the Gate 2 Codex review at T13)
adversary: not run yet, attacks run: 0, test: tests/t11-update-coverage.spec.ts. Before T13, with the reframed brief noted under T10

update_coverage, and I2 as a property rather than as a single assertion.

verify, each command run ALONE (see the note at the end):

  anchor test         70 passing, 0 failing  (was 64)
  cargo test          38 passed; 0 failed    (was 37)
  cargo clippy --all-targets -- -D warnings   clean
  cargo fmt --check                            clean

  T11 update_coverage and I2
    ✔ I2 holds after every instruction, through a full round and a price fall
    ✔ allocates in turn order, earliest recipient first, capped at what is left
    ✔ coverage saturates for a member who owes nothing, and is a number for one
      who does
    ✔ validates the member accounts: order, count and writability
    ✔ anyone can recheck, and a stale price refuses
    ✔ refuses once the circle is Completed

done when: I2 property test green.

I2 IS CHECKED AS A PROPERTY, NOT AS AN ASSERTION ABOUT THIS INSTRUCTION.
INVARIANTS.md states it holds "after every instruction", so `assertI2` runs
after each of five joins, after activate, after each of five contributes, after
release_pot, and after three update_coverage calls at falling prices. Checking
it only after update_coverage would have proved the easy half.

Its first half, `reserve_allocated <= reserve_total - reserve_losses`, is a
property of `allocate_in_turn_order` and is proved over arbitrary inputs in
gate.rs rather than over the inputs a test happened to pick:

  test gate::tests::allocation_follows_turn_order_and_never_exceeds_the_reserve

THE ALLOCATION IS THE POINT OF THIS TASK. release_pot's gate compares the
UNCAPPED sum and refuses if it does not fit. update_coverage always succeeds and
distributes what there is, in turn order, capping each member at what is left.
SPEC.md:126 is the line that separates them: the gate's `remaining` is R - L,
while `reserve_allocated` everywhere else is the capped, turn-order figure.

Turn order is a rule and not a tie-break. The member who receives soonest is the
member whose obligations the circle must stand behind soonest. Distributing pro
rata would leave everyone partly covered and nobody releasable, which is the
worse outcome for the same money. The test pins the exact split at a scarce
price: 151, 24, 0, 0, 0 against a 175 reserve, which is only correct if the
first seat is filled before the second is looked at.

A Paused circle is not one this instruction refuses. It succeeds and returns
next_gate_short_by > 0, which is what I18 defines Paused as.

MY OWN TESTING ERROR, TWICE, RECORDED SO IT STOPS. Two separate runs reported
failures that did not exist: once from two `anchor test` invocations in one
shell line, once from `anchor test` sharing a line with `cargo fmt`, which
rewrote the sources while the suite was running. Both fight over target/. Every
verification command in this entry was run alone. A test run that races the
formatter is not evidence of anything.

## T12 - 2026-09-23

reviewed: n/a (covered by the Gate 2 Codex review at T13)
adversary: not run yet, attacks run: 0, test: tests/t12-withdraw.spec.ts. Before T13

withdraw, the one way money leaves a finished circle, for both endings.

verify, each command run ALONE:

  anchor test         74 passing, 0 failing  (was 70)
  cargo test          43 passed; 0 failed    (was 38)
  cargo clippy --all-targets -- -D warnings   clean
  cargo fmt --check                            clean
  pnpm exec tsc --noEmit                       clean

  T12 withdraw, I3, I11 and I16
    ✔ refuses while the circle is still running, and refuses twice after
    ✔ a cancelled circle returns exactly what each member put in
    ✔ I3 and I11: a completed circle pays every deposit back and never more
    ✔ I16: withdraw order does not change any member's amount

done when: I3, I11, I16 green. All three.

I16 IS THE ONE WORTH READING. SPEC §7 says "snapshot values, never decremented
by withdraw", and that is not a style note: withdraw does not touch
reserve_total, reserve_losses or escrow, so every member's share is computed
against the same three numbers no matter who goes first. The implementation it
rules out is the obvious one, paying out of a pool that shrinks as people
withdraw, which makes the last member's share depend on an order they do not
control.

The test runs the same circle to Completed THREE times and withdraws in three
different orders, comparing every member's payout across all three. A single
order would have proved nothing, because the bug only shows for whoever goes
last.

The pro-rata arithmetic is degenerate in gate 2: unequal weights need a default
(T15) or a top-up (T16), so every weight here is 35 USDC and every share is 35
USDC. Rather than leave it untested until then, completed_share has its own
Rust unit tests with asymmetric inputs, including a 40 USDC loss shared across
four survivors (33.75 each), a forfeited member receiving nothing, and dust
staying in the vault rather than overpaying the last member.

THREE TEST DEFECTS FOUND AND FIXED, all the same shape and all mine.

Four tests did "call X, then call X again and expect a refusal" with byte
identical transactions. The runtime rejects the second by SIGNATURE, "This
transaction has already been processed", so the program is never reached. Those
tests would have passed against a program with no such check at all. Surfaced
when the T09 cancel-twice case finally failed, having been passing for the wrong
reason.

Fixed with a harness helper, h.nextSlot(), used at all four sites. Proved to
bite by mutation: with the AlreadyContributed check deleted from contribute.rs,

  contribute refuses twice, and refuses a circle that is not Active:
    Error: expected the instruction to be refused, but it succeeded

Before the fix that mutant survived.

The helper itself then had the same class of fault. warpToSlot recomputes the
clock from the bank and discards whatever setClock had put there, so the first
version moved the wall clock as well as the blockhash and a test asserting
CircleNotActive silently began asserting PriceStale. It now restores the
timestamp, so it changes the blockhash and nothing else.

AND tsc WAS NOT BEING RUN ON THE TEST SUITE. anchor test runs mocha through tsx,
which strips types without checking them, so tests/*.spec.ts had accumulated
five type errors: harness.ts's Callable type never declared remainingAccounts,
which every gate instruction uses. `pnpm exec tsc --noEmit` is now part of this
entry's verification and is clean.

## T10-T12 adversary - 2026-09-23

reviewed: n/a (covered by the Gate 2 Codex review at T13)
adversary: NO DEFECT FOUND, attacks run: ~40 across the gate, release_pot state, update_coverage, withdraw, prices, authority and arithmetic. test: tests/t10-adversary.spec.ts (integrated, 9 cases, passing)

Briefed differently from T09's pass, on purpose. That one found the
`guarantee = 2^63` behaviour, recorded "No wrap", and passed the change, while
Codex took the same input and called the circle bricked. So this brief required
two answers per attack: did anything move wrongly, AND what IS the circle
afterwards, can it still reach its end, is anyone's money stuck.

It broke nothing. Its nine tests are integrated and pass:

  anchor test   85 passing  (74 before its tests, 83 with them, 85 with the two
                             refusal-event tests below)
  cargo test    43 passed; 0 failed
  clippy, fmt, tsc   clean

Two of its cases are worth naming. It pins the gate AT ONE BASE UNIT, with
parameters chosen so the requirement lands on 177_773_331.5556 and the counted
value equals the price exactly: at cover 2_773_332 the pot must pay and at
2_773_331 it must refuse. A gate that floored the requirement, or compared with
`<`, moves that boundary by one unit and fails one side. The existing T10 tests
move the price in whole dollars and would not have noticed. And it wrote a
DIFFERENTIAL SWEEP over 16 prices, re-implementing SPEC §4 and §5 in the test
and asserting the program's pass/refuse decision, its reserve_allocated and its
choice between CoverageTooLow and ReserveOvercommitted, at every price.

ONE REAL FINDING, WHICH IT GRADED COSMETIC AND I DID NOT.

SPEC.md:204: "Every refusal payload field named in section 5 is emitted as an
event before the error returns, so the UI can print the numbers." The gate
refusal used `msg!` and `round_not_funded` emitted nothing at all, though
SPEC.md:106 specifies five fields for it.

It called this cosmetic because every field is reconstructible from the Circle
account the UI already fetches. That is true and it is not the point. A msg! line
is free text the client parses by hand and that nothing protects when it changes;
an event is typed, declared in the IDL and decoded by the client library. The
SPEC says event. NFR-2 says every refusal carries the numbers the UI needs.

Fixed: `PotRefused` and `RoundNotFunded` events, emitted before the error
returns. The transaction fails, so nothing lands on chain, but FLOWS §9 previews
every transaction by simulation and a simulated failure returns its logs, which
is exactly where a Paused screen reads its numbers.

Two tests decode the events properly, through BorshEventCoder, rather than
grepping the log text, which is the part that proves it is an event and not a
message. Mutation-checked: reporting only the FIRST missing seat instead of all
of them fails with `4 !== 20`, that is 0b00100 against 0b10100.

DEAD CODE IT SPOTTED, REMOVED. release_pot set the paid bit for each
escrow-covered defaulted seat and then zeroed the whole bitmap four lines later.
The writes could never be read. Dead state writes read as live ones to whoever
comes next, which is the same fault as T09's unreachable AlreadyJoined guard.
The part of that clause that DOES outlive the round, rounds_paid++, is on the
Member and is untouched.

Its second suspicion is recorded in OPEN-QUESTIONS: KNOWN-LIMITS L4 says a stuck
Active circle is unreachable "without a default or price fall", and a stale feed
is neither. release_pot and update_coverage refuse for ever while contribute
keeps accepting money, because SPEC.md:105 deliberately gives contribute no
price check. On a real xStock the multiplier change is the ISSUER's, so the
trigger is outside every party in the circle. Design-level; the build has not
touched L4.

WHAT IT COULD NOT REACH, in its own words: anything needing declare_default
(T15) or top_up_reserve / add_stock (T16). That leaves the escrow branch of
release_pot, reserve_losses > 0, forfeited > 0, escrow_deficit > 0 and therefore
the non-degenerate pro-rata in withdraw all unexecuted by anyone. It read them
against SPEC §6 and §7 and reports they match, and says plainly that it did not
prove it by execution. I14, I15 and the unhealthy half of I18 remain untested.

## T13 - 2026-09-23

reviewed: PENDING. reviews/gate-2-brief.md written at 62d5f74; the verdict line and its findings land in reviews/gate-2-review.md when Joshua has run it
adversary: two passes, both NO DEFECT FOUND, 23 attacks on T09 and ~40 on T10-T12; their tests are integrated as tests/t09-adversary.spec.ts and tests/t10-adversary.spec.ts

The gate 2 brief. Written and STOPPED, per AGENTS.md: the build does not review
its own diff.

verify: `./scripts/check-reviews.sh` passes.

Scope of the brief: origin/staging..62d5f74, which is T08 through T12 and 5,112
insertions across 23 files. It FOLDS IN the early T09 structural review, as
TASKS.md required, because T10 to T12 landed after that pass and invalidated it
by design. Without that, a brief written now would naturally cover T10 to T12
and quietly skip the shape they were built on: the ATA vaults, init-if-needed,
the Member layout and the two-token-program question.

G2's THIRD CLAUSE IS NOT FULLY MET AND THE BRIEF SAYS SO. "Every section 5
refusal code has a negative test." Two do not have one. `MultiplierInvalid` is
unreachable through an allowlisted mint, because all four fixtures decode.
`AlreadyDefaulted` needs declare_default, which is T15. Both are structural
rather than oversights, and neither is fixed rather than quietly reworded. An
audit of every declared error against every code asserted in the suite is what
found them; 20 of 22 are covered.

The brief also states, rather than leaving to be discovered: that everything
downstream of a default is unexecuted by anyone, including the escrow branch of
release_pot and the non-degenerate pro-rata in withdraw; that I3 is asserted as
a band with a dust allowance and not an equality; that the compute figures are
bankrun's and not a validator's; and that the two adversarial passes are what
has already been swept and not a claim of correctness, including that the T09
pass PASSED a finding an external reviewer later called a bricked circle.

Seven open items are listed so they are not re-reported, including the one that
still blocks deployment: init_price_feed has no authority gate, so the first
caller becomes the oracle for that mint. BLOCKING before T23.

The prompt for Joshua to run is in the session; the brief cites
/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md by ABSOLUTE path,
because it is a cross-project standard living in another repo and a relative
path resolves only if the reviewer starts a directory above this one. Gate 1's
brief used the relative form and got away with it.

## T13 r2 - 2026-09-24

reviewed: reviews/gate-2-review.md | verdict: changes required | commit: 62d5f74
adversary: two passes, both NO DEFECT FOUND; their tests are integrated

Codex returned three findings. Two were mine to fix and are fixed. The third is
the design session's and is recorded, not invented around.

MAJOR, FIXED, AND I WAS WRONG IN THE WAY IT SAID. The brief claimed
MultiplierInvalid and AlreadyDefaulted were structurally untestable. They were
not. I had confused "unreachable in production" with "untestable", which are
different things: the harness writes arbitrary account bytes at arbitrary
addresses, which is how every fixture in this repo already works.

tests/t13-refusal-coverage.spec.ts reaches both the way Codex described.
AlreadyDefaulted marks a seat on the Circle account, which is the state
declare_default will eventually write, and asserts contribute refuses, then
asserts every other member can still pay, so a default does not halt the round
for people who did nothing. MultiplierInvalid puts a mint whose scaled
multiplier is NaN, +inf, negative, negative zero or zero at the ALLOWLISTED
address, because ADR-012 governs which address may be used and says nothing
about the bytes there, which the issuer owns.

  ✔ contribute refuses a member whose seat is marked defaulted
  ✔ the valuation path refuses a mint whose multiplier cannot be read safely

  anchor test: 87 passing, 0 failing (was 85)

G2's third clause is now met, audited rather than asserted: every declared error
against every code the suite asserts gives declared 22, covered 22, nothing
uncovered.

MINOR, FIXED. The brief said five init_if_needed uses and two associated-token
constraints per instruction. Counted: six uses, and 4/2/4 constraints across
join_and_lock, release_pot and withdraw. A U2 failure in my own review map, so
the brief now carries the table rather than a recalled number.

CRITICAL, NOT FIXED, AND NOT MINE TO FIX. A member who joins a Forming circle
cannot recover their stock or guarantee if the creator does nothing. Only the
creator can cancel, and withdraw refuses unless Completed or Cancelled, so an
ordinary stalled formation, with no bad actor at all, leaves a live circle
holding money with no exit.

SPEC.md:102-104 is what makes that true, so it is a SPEC correction and
AGENTS.md is explicit: if the design is wrong, stop and say so, and the pack is
re-handed. Recorded in OPEN-QUESTIONS as BLOCKING before T23, because deploying
a program that can lock a member's funds is worse than not deploying.

GATE 2 IS THEREFORE NOT CLOSED, and scripts/check-reviews.sh now fails on this
branch saying so. That is the guard reporting an unclosed gate, not a broken
check: it refuses while a review in reviews/ says changes required. It clears
when Codex re-reviews after the design decision, or when the design session
records a deliberate override in KNOWN-LIMITS.md, which the build does not own.

## leave_forming (G2 repair) - 2026-09-24

reviewed: reviews/gate-2-review.md raised it | the repair itself awaits the gate 2 re-review
adversary: not run on this instruction yet. Before the re-review

Codex's gate 2 CRITICAL: a member who joined a Forming circle could not recover
their stock or guarantee if the creator did nothing. Only the creator could
cancel, and withdraw refuses unless Completed or Cancelled, so an ordinary
stalled formation left a live circle holding other people's money with no exit.

The design's answer, decided 2026-09-24: any JOINED member may leave at any time
before activation. No formation deadline, no override for anyone else. The
asymmetry that caused it was that joining was the member's decision and leaving
was not; this removes it rather than adding a timer someone still has to watch.

verify: `anchor test`

  leave_forming: a member's own way out of a stalled circle
    ✔ two of three join, the third never does, and each leaver gets everything back
    ✔ the Member account is closed, so the same wallet can rejoin cleanly
    ✔ refuses once the circle is Active, and once it is Cancelled
    ✔ a member who stays is still refunded by cancel and withdraw
    ✔ refuses a wallet that never joined, and one that already left

  92 passing, 0 failing (was 87)
  clippy, fmt, tsc clean, each run alone

THE FIRST TEST IS THE REPORTED SCENARIO EXACTLY, at n = 3, the smallest circle
SPEC allows and the shape the finding was written against. Two join, the third
never does, activate refuses NotAllJoined, the creator does nothing, and each
member leaves independently. Both get every locked token and the whole guarantee
back to the base unit, and both vaults end empty: the circle holds nothing of
anyone's.

WHAT MOVES, AND WHAT DELIBERATELY DOES NOT. joined_bitmap clears the seat.
reserve_total and deposits_total both come down: reserve_total because the money
left the vault, which is I3, and deposits_total because it is the denominator of
withdraw's pro rata and must count only deposits still settled here.
withdrawn_usdc and withdrawn_bitmap are untouched, because they describe a
FINISHED circle: counting an unwind as a withdrawal would make I11 read a refund
as a payout, and would mark a seat withdrawn that may yet rejoin.

The Member account is CLOSED to the wallet rather than zeroed, which is what
makes a clean rejoin work: join_and_lock uses plain `init`, and `init` on a
husk would fail. The test asserts the account is gone and then rejoins, and that
deposits_total counts that join once rather than twice.

top_ups is included in the refund although it cannot be non-zero in Forming,
because top_up_reserve is Active only. The unwind is then the exact inverse of
everything that ever entered on a member's behalf, so if that ever changes this
returns the money rather than stranding it.

MUTATION-CHECKED on the line the repair turns on. Removing the deposits_total
subtraction, which is the "ever deposited" reading the design has now reworded,
is caught by two tests:

  and so does deposits_total, which is now settled deposits and not ever-deposited
  + actual 70000000
  - expected 35000000

STILL OWED, AND WHY GATE 2 STAYS OPEN: SPEC.md needs the leave_forming row in §5
and the deposits_total rewording. Both are the design session's, and AGENTS.md
forbids this build editing SPEC.md. Gate 2 closes when the pack is updated and
Codex re-reviews.

## T13 r3 - 2026-09-24

reviewed: reviews/gate-2-review.md | verdict: changes required (r2) | commit: 7307806
adversary: not re-run; the corrections below are to documentation and one added unit test

Codex's r2: the asset-lock repair passes, and 22 of 22 refusal coverage passes.
Closure still needs three corrections. Two were mine and are made. The third is
the design owner's.

1. THE BRIEF STILL SAID SIX init_if_needed USES. It was right at r1 and went stale
   the moment leave_forming added two more. Counted from source at this commit:

     join_and_lock 3 / 4     leave_forming 2 / 4     release_pot 1 / 2
     withdraw      2 / 4     total         8 / 14
     (init_if_needed / associated_token constraints)

   That table has now been wrong twice, both times because it was carried
   forward instead of recounted. The brief states that the figures were counted
   with grep -c at the commit under review, and no longer claims a regeneration
   process that does not exist; an earlier draft of this fix did claim one.

2. MY n = 3 FIXTURE COMMENT SAID THE PEAK WAS 0. It is 10 USDC. At k = 1 the
   member who has received still owes TWO rounds, ceil(50 x 2 x 1.3) = 130
   against a 120 minimum, a gap of 10. The comment counted one remaining round.
   The test itself was never wrong: 35 x 3 = 105 clears a peak of 10.

   Corrected, and made load-bearing rather than just reworded. A number that
   lives only in a comment is a number nothing checks, so
   `peak_for_the_smallest_circle_is_ten` in create_circle.rs now pins it, and
   the comment points at that test:

     test ...::peak_for_the_smallest_circle_is_ten ... ok

3. THE TWO SPEC.md EDITS: not the build's. The field rewording at SPEC.md:58 and
   the leave_forming row after SPEC.md:103 were drafted in the session for the
   design owner to apply. AGENTS.md forbids this build editing SPEC.md.

verify, each run alone:
  anchor test   92 passing, 0 failing
  cargo test    44 passed (was 43)
  clippy, fmt, tsc   clean

check-reviews.sh stays red on this branch, correctly. It clears when the design
owner applies the SPEC edits and Codex re-reviews. T14 stays stopped, per
Joshua and per the r2 verdict.

## T14 init_pool / seed_pool, and the admin root (2026-09-24)
reviewed: n/a (covered by Codex Gate 3 review at T17)
adversary: NO DEFECT FOUND against 0af634b, attacks run: 14, test: tests/t14-adversary.spec.ts (10 integrated, 1 withheld, see below)

Restarted by Joshua ("yes upgrade next, then continue with T14"). T14 had been
stopped because two recorded findings were owed to it; both are closed here.

1. THE ADMIN ROOT (OPEN-QUESTIONS, BLOCKING before T23: oracle takeover).
   The admin is the program's upgrade authority, read from the upgradeable
   loader's ProgramData account. init_price_feed and init_pool require it;
   set_prices, touch_prices and seed_pool were already gated by the authority
   those two record. Anchor's documented pattern: `program` must be Othello,
   its programdata_address() must be the `program_data` passed, and that
   account's upgrade_authority_address must be the signer. Both constraints
   map to `unauthorized`, the refusal SPEC:114 and SPEC:116 already name.

   The harness had to change for this to be testable at all. startAnchor
   loads programs through the old non-upgradeable loader (probed:
   owner BPFLoader2111..., no ProgramData), so every admin instruction would
   refuse. The harness now places Othello again as a real upgradeable deploy
   leaves it (program account -> ProgramData with the ELF and an upgrade
   authority), with h.authority as that authority. All 92 existing tests
   pass unchanged on that load.

2. USDC MINT (OPEN-QUESTIONS, T09 adversary): init_pool refuses any USDC mint
   not owned by classic SPL Token (`invalid_params`). Circles take the USDC
   mint from the pool's seeds, so this one check covers every circle.

3. init_pool / seed_pool per SPEC:116. discount_bps < 10000; stock mint on
   the ADR-012 allowlist; both pool vaults are ATAs owned by the pool PDA,
   created with init_if_needed because anyone can create an ATA for any
   owner and a plain `init` could be blocked forever by one stranger's
   transaction (tested). seed_pool moves only the signer's own USDC (I8),
   refuses zero and more than the balance. Events PoolInitialized and
   PoolSeeded added (an event per state change).

init_if_needed uses, recounted from source at this commit (real uses, not grep
hits: pool.rs has three grep hits, one of them the comment explaining why):
  join_and_lock 3   leave_forming 2   release_pot 1   withdraw 2   pool 2   total 10

MUTATION TEST, each check removed in turn, t14 spec rerun, source restored by
cp from a backup (never git checkout), rebuilt clean afterwards:
  M1 feed: no upgrade-authority check: 11 passing (5s) 2 failing
  M2 feed: no programdata binding: 12 passing (5s) 1 failing
  M3 pool: no upgrade-authority check: 11 passing (3s) 2 failing
  M4 pool: USDC may be Token-2022: 12 passing (6s) 1 failing
  M5 pool: plain init on USDC vault: 12 passing (5s) 1 failing
  M6 pool: discount 100% allowed: 12 passing (5s) 1 failing
  M7 pool: no allowlist: 12 passing (5s) 1 failing
  M8 seed: no authority check: 12 passing (2s) 1 failing
  M9 seed: zero allowed: 12 passing (5s) 1 failing
  M10 seed: no balance precheck: 12 passing (5s) 1 failing
  sources restored
  rebuilt clean

verify, each run alone:
  anchor test   105 passing (50s)       (92 before + 13 in t14-pool.spec.ts)
  cargo test    44 passed
  cargo fmt --check, cargo clippy --all-targets -D warnings, tsc --noEmit: clean

SPEC wording owed by the design owner (drafted as apply-spec-r6.py, not applied
by the build): who "admin" is, init_pool's USDC-mint rule, and the two events.
check-reviews.sh is red on this branch for the inherited reason: it stacks on
task/T09-join-and-lock, whose gate 2 verdict is still "changes required" until r4.

T14 ADVERSARY PASS (same day, against 0af634b): no defect. 14 attacks, each
refused for a stated reason: stranger admin; stranger's own ProgramData; a
different executable as `program` (InvalidProgramId); a loader Buffer account
as ProgramData (AccountNotProgramData); immutable program; pool PDA, feed PDA
and vaults pre-funded or pre-created (init_pool and init_price_feed still
succeed); Token-2022 USDC declared either way; second init_pool (account in
use); seed_pool from an account the admin is only delegate on
(ConstraintTokenOwner); seed_pool into a non-ATA pool account
(ConstraintAssociated); seed_pool against another pair's pool; and a harness
sanity check that rewriting the ProgramData authority byte changes who is
admin, so the harness is not passing tests for the wrong reason.

Integrated into tests/t14-adversary.spec.ts, run on this branch:
  10 passing (2s)
One test withheld: it showed that a feed's recorded authority keeps
set_prices after the upgrade authority is rotated. That is current behaviour
and an open design decision, recorded in OPEN-QUESTIONS.md rather than pinned
by a passing test. Also noted: seed_pool's InsufficientBalance is not in SPEC
§5's refusal list for that row; r6 added it.

## T15 declare_default: the SPEC §6 waterfall (2026-09-24)
reviewed: n/a (covered by Codex Gate 3 review at T17)
adversary: DEFECT fixed in the commit after 23bcf58, attacks run: 12, test: tests/t15-adversary.spec.ts

declare_default(turn), exactly per SPEC §5's row and §6. Preconditions in the
row's order: Active, turn < n, now > deadline + grace (strict, I7), seat unpaid,
received(turn) (else PrePayoutDefaultUnsupported, KNOWN-LIMITS L3), not already
defaulted, wrapper price fresh and non-zero, pool USDC >= recovered. Then the
sale (circle signs its stock to the pool vault, the pool signs USDC back) and
the books line by line. Four error codes appended: GraceNotElapsed,
SeatAlreadyPaid, PrePayoutDefaultUnsupported, PoolInsufficient. Event
DefaultDeclared carries every waterfall figure.

The arithmetic is a pure `waterfall()` so it is unit-tested without a
transaction. Two SPEC edges made explicit: a conservative price of zero sells
NOTHING (ceil(O/0) is undefined, and selling for zero would take stock for no
money), and a mint whose multiplier cannot be read takes the capped branch
rather than refusing, because the sale never needed it.

Recompute: the normal branch is update_coverage's own code. That recompute
was EXTRACTED from update_coverage into `load_members` + `recompute_coverage`
(pub(crate)), which both instructions call, because SPEC says "exactly as
update_coverage" and one copy is the only way that stays true. Behaviour is
unchanged; the one difference is that all Member accounts are validated
before any is valued, rather than interleaved. The full suite passed on it
before declare_default existed (105 passing). The capped branch (Repricing)
is written as SPEC r4 states it.

Tests. Unit, programs/othello/src/instructions/declare_default.rs, 6: the demo
numbers (sell all 1.1 tokens for 132, loss 68, forfeit 35); a late default
selling only 83,333,334 raw; I9 swept over five wrapper prices and every
rounds_paid; the escrow deficit; the r3 forfeit rule where it actually differs
from the loss; a price too small to buy anything. End to end,
tests/t15-declare-default.spec.ts, 9, on a pool made by init_pool and funded by
seed_pool, with I2, I3 and I4 checked after each step: the demo default with
the real token movements; then escrow paying the defaulted seat until
Completed, and a Completed circle refusing (CircleNotActive); the late
default; I7 at exactly deadline + grace (refused) and one second later
(accepted), measured from a release made 1,000 s late; SeatAlreadyPaid,
PrePayoutDefaultUnsupported, InvalidParams, AlreadyDefaulted; PoolInsufficient
and PriceStale; the Repricing branch (I13, I2, last_coverage_at unstamped);
Repricing with a deficit; and the escrow deficit on the normal branch.

MUTATION TEST, each change made alone, unit + e2e rerun, restored by cp:
  M1 grace >= instead of >              e2e 1 failing
  M2 no received check                  e2e 1 failing
  M3 no paid check                      e2e 1 failing
  M4 forfeit against loss               unit 1 failed
  M5 escrow omits the loss              e2e 4 failing
  M6 no pool balance check              e2e 1 failing
  M7 always full recompute              e2e 1 failing
  M8 floor instead of ceil              unit 2 failed, e2e 1 failing
  M9 no stale check                     e2e 1 failing
  M10 stock not reduced                 e2e 5 failing
  M11 capped branch forgets the deficit SURVIVED the first run (the Repricing
      test had a deficit of 0); the Repricing-with-deficit test was added and
      M11 then fails it: 8 passing, 1 failing
  M12 no already-defaulted check        e2e 1 failing
  source restored, rebuilt clean

verify:
  anchor test   124 passing (1m), exit 0 after 87s
  cargo test    50 passed
  cargo fmt --check clean (after cargo fmt; whitespace only, in the new file)
  cargo clippy --all-targets -D warnings: 0 warnings
  tsc --noEmit clean

OBSERVED AND NOT EXPLAINED: one `anchor test` run earlier in this task did
not finish. Its mocha process sat for over an hour at ~650% CPU and 2.7 GB
before I killed it. Every run since has been clean: each of the 18 spec files
alone (124 tests), all of them in one mocha process (124 passing, 1m), and
`anchor test` again (87 s). Recorded rather than guessed at; if it recurs,
the per-file timings above are the baseline.

T15 ADVERSARY PASS (against 23bcf58): ONE DEFECT, low severity, no money at
risk. The capped branch (Repricing, or an unreadable multiplier) left the
defaulter's last_coverage_bps at its old percentage; SPEC.md:70 says a
defaulted member reads u32::MAX, which the UI renders as "Prepaid". The
adversary's failing test, verbatim:
  AssertionError [ERR_ASSERTION]: a defaulted member's last_coverage_bps must read u32::MAX (Prepaid)
  + 13000
  - 4294967295
Fixed where the defaulter's other fields are set, so it holds on both
branches. Its 4 tests are integrated as tests/t15-adversary.spec.ts (the
failing one kept as the regression guard, plus a normal-branch control,
reordered/duplicated/read-only Member accounts, and a defaulter who cannot
contribute and withdraws only what it did not forfeit after completion,
I11/I15). 11 other attacks failed, each for a stated reason. Its one unproven
suspicion, that capped survivors keep an older higher last_coverage_bps, is
allowed by SPEC ("as of last recompute") and is recorded in OPEN-QUESTIONS.

verify after the fix:
  every spec file in its own process: 128 passing, 0 failing (19 files)
  anchor test   128 passing (58s), exit 0 after 81s
  cargo test 50 passed; fmt clean; clippy 0 warnings; tsc clean

THE STALL, NOW SEEN THREE TIMES. A single-process run of all specs (anchor
test, or mocha over the glob) sometimes stalls with no output. Every
occurrence was while the machine was heavily loaded by another project's
mutation-testing run (load average 32 to 52 on 22 cores); at load 12 to 16 the
same command passes in 81 s, and every file always passes in its own process.
Correlated with load, not proven to be caused by it. mocha --parallel was
tried and is NOT a fix: one test failed under it and one run also stalled.
