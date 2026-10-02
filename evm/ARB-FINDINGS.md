# Findings while building ARB-DESIGN r9 (for the code review)

Design: `othello-design/arb/ARB-DESIGN.md` r9, sha256 `ca3b3c8c…8284`, Codex SHIP
(`reviews/arb-design-review-r8.md`). These are places where building the design showed something the
design text did not say. None changes a rule; each is stated here so the reviewer can check it.

## F-1. An escrow deficit cannot arise in a USDG-only circle

**Claim.** With USDG collateral valued 1:1, `escrowDeficit` stays 0 in every reachable state.

**Why.** At a default, `shortfall = O − seized = O − min(collateral, O) ≤ O − H` because `H ≤ collateral`.
And `need = ceil(O × coverage / 10000) − H ≥ O − H` because `coverage ≥ 10000`. So every shortfall is at
most the defaulter's `need`. The last successful gate (release) required `Σ need ≤ R − L` over every
received, non-defaulted member, with the same `O` the default will use: a member who received in round
`r` has `roundsPaid = r + 1` at that release, and at a default in round `r + 1` still has `r + 1`. A
member's `H` never falls: collateral only grows (`addStock`) until that member's own seizure. So the
losses of any set of defaults are covered by the reserve the gate already required, and
`loss = min(shortfall, R − L) = shortfall` every time.

**Evidence.**
- 20,000 random circles (n 3–8, mixed parameters, members skipping rounds, defaults in and out of queue
  order, pauses cured by top-ups): 2,843 paused gates, **0** deficits, **0** `CoverageTooLow`.
- Foundry invariant `invariant_no_escrow_deficit`: 256 runs × 200 calls, holds.
- `core/test_core.py::Rules::test_escrow_deficit_unreachable_first_default_bound`.

**Consequences.**
- The design's §7.1 row "deficit top-up disclosure" (reserve exhausted by a default, deficit > 0, a member
  tops up) cannot be produced by a real sequence. The code path is still built and tested with the
  deficit **forced** into storage (`test/OthelloCircle.t.sol`: `test_topup_refuses_when_deficit_rose_after_read`,
  `..._cleared_first`, `..._applies_exact_fill`, `..._fill_smaller_than_deficit`). The same holds for
  §7.1 top-up consent case (a), "an intervening `declareDefault` raises the deficit".
- For a user this is good news: on Robinhood today, a top-up never pays for someone else's missed payment;
  the §6 subsidy sentence will not show (`fill` is always 0). It stays in the contract and the copy
  because C1 (price-backed collateral) makes deficits reachable again.
- Paused (`ReserveOvercommitted`) **is** reachable: a default uses up reserve that the *next* recipient's
  need was counting on. A top-up of exactly `nextGateShortBy` cures it (vectors include one).

## F-2. `CoverageTooLow` cannot be raised with USDG collateral

It needs the recipient's `H < minStockCover`. Every recipient joined with `H ≥ minStockCover`, has never
received, so has never defaulted, so their collateral never fell. The branch is kept (it is the SPEC
rule) and listed as mutation M37, an expected survivor because it is unreachable.

## F-3. `common-v1` carries `declareDefault` refusals only

The design puts "the queue" in `common-v1` and "internal seizure" in `evm-usdg-v1`. A successful default's
state change is chain-specific (EVM seizes USDG in place; Solana sells stock through a pool), so a
`common-v1` vector never contains a successful `declareDefault`: `ACTIONS.json` marks it
`successAllowed: false`, the generator refuses to emit one, and `CommonModel` has no settlement. Its
refusals (grace, pre-payout, not marked, out of order) are shared and replayed.

## F-4. Zero-amount outbound transfers are skipped

`_push(to, 0)` returns without calling USDG. Only `withdraw` can have a zero total (a defaulter whose
collateral was fully seized and whose pooled weight is 0). Skipping it changes no state and no balance;
calling USDG with 0 would add an external call for nothing.

## F-5. `addStock` refusal order for a non-member in Forming

The design's first check is "status Forming-and-joined or Active (`CircleNotActive`)". Read literally, a
non-member calling `addStock` while Forming gets `CircleNotActive` (not joined), while in Active they get
`NotAMember`. Built literally, in both the model and the contract.

## F-6. Surplus sent before or during a circle

Replay and unit tests confirm unsolicited USDG is never counted, paid or swept (AL9). The page must say so
before anyone sends (design §3.3 copy).

## F-7. `trust-config` ties live code to the reviewed source without an explorer (code review r1)

ARB §7.1 names `forge verify-bytecode` for the source check. `ops/trust-config.ts` does the same comparison
locally: it takes the reviewed commit's compiled runtime (`evm/out`, same solc 0.8.30 and settings, metadata hash
included), fills the factory's one immutable (USDG) at its recorded offsets, and requires its keccak to equal both
the config hash and the live `eth_getCode` hash. This needs no Blockscout API and cannot pass on a different
compiler, source or constructor argument. It also checks the receipt (chain, single CREATE, address, USDG
argument, success) and that the receipt's commit is an ancestor of HEAD with `evm/src` and the deploy script
unchanged. `script/DeployFactory.s.sol` deploys the factory alone for the page path.

## F-8. Join copy follows F-1 (code review r1)

The Join list no longer says a restart top-up "covers others and may not come back": with USDG collateral a
top-up's fill is always 0. It now says a top-up joins the shared reserve and comes back through the end-of-circle
split, which later losses can reduce. The exact-subsidy sentence remains only on the top-up form, shown when a
fill is actually non-zero (a future collateral profile).

## F-9. trust-config hardened after its adversary pass

The first gate parsed `config.ts` as text, so a commented-out null line made a set config read as null and pass
(adversary test `tests/trust-config-hostile-config.spec.ts`). The gate now imports `config.ts` as a module and
checks the exported value's exact shape; it requires every `checkTrusted` / `createRobinhoodAdapter` call in
`app/src` to pass `TRUSTED_FACTORY` imported from the config module, and no other file to declare one; and it
asks the chain for the receipt's deployment transaction, requiring a contract creation whose input is exactly the
reviewed init code plus USDG, successful, that created the config address (a same-runtime contract with other init
code, e.g. one that pre-registers a circle in storage, fails). CI now re-runs it on any change under `app/src`.

## F-10. Trust is structural, not scanned (third trust-config adversary pass)

The second gate still matched call text, so a renamed import (`checkTrusted as x`) with a hard-coded factory got
past it, and a config computed at run time (`typeof window === "undefined" ? A : B`) showed Node one factory and the
browser another (`tests/trust-config-trust-sources.spec.ts`). Changes:
- **No factory parameter in the app's API.** `lib/robinhood/adapter.ts` binds `TRUSTED_FACTORY` itself;
  `checkTrusted(client, circle)` and `createRobinhoodAdapter(deps)` take no factory. The injectable implementation is
  `adapter-core.ts` (tests use it). CI's import boundary (TypeScript AST, resolving `@/` and relative paths; static,
  dynamic, `require`, re-export; `.ts/.tsx/.js/.jsx/.mjs/.cjs`) allows only `adapter.ts` to import `config` or
  `adapter-core`; a computed dynamic import anywhere in `app/src` fails. Type-only imports are allowed.
- **config.ts has a fixed shape** (AST): `null` or `Object.freeze({ address: "…", codeHash: "…" })` with two string
  literals; the imported value must equal it and be frozen. Nothing computed can pass.
- **After the reviewed deploy only the config, the receipt and Markdown notes may change** (git diff from the
  receipt's commit). Any code, build-config or dependency change after review 2's SHIP fails the gate.
- **Limit, stated plainly:** a static gate cannot prove that code written to deceive it is harmless (for example
  `eval`). While the config is null, the boundary scan is the check and the page offers no action; once it is set,
  nothing but the config and receipt may differ from the commit Codex approved at review 2.
CI re-runs the gate on any change under `app/`.

## F-11. What the bundler loads, renames, and the receipt's commit (fourth trust-config adversary pass)

- **Shadow modules.** Next resolves `./config` trying `.js` before `.ts`, so a `config.js` beside `config.ts` was what
  the page loaded while the gate checked `config.ts` (proved with a real `next build`,
  `tests/trust-config-shadow-module.spec.ts`). Now `app/src` may hold no JavaScript module file and no two files
  differing only by module extension; `app/next.config.mjs` and `app/tsconfig.json` (path aliases, resolve rules)
  are pinned by sha256 in the gate, and any other `next.config.*` or `jsconfig.json` fails. The gate reports these
  before reading anything else.
- **Renames.** `git diff --name-only` folds a rename into its new name, so `git mv X X.md` hid X's deletion
  (`tests/trust-config-rename-hides-delete.spec.ts`). The diff now uses `--no-renames`.
- **Smuggled fields.** The app's `createRobinhoodAdapter` now picks its four fields one by one, so an object with
  extra `factory` or `usdg` properties cannot override the trusted factory or the real USDG.
- **Strict addresses.** A config address must be all-lowercase or carry a valid EIP-55 checksum.
- **Limit (not closable in CI):** the receipt's `commit` is written by whoever makes the config commit, so nothing
  in the repo proves it is the review-2 SHIP commit. Review 3 checks that equality by hand; the gate then proves
  nothing else changed since that commit.

## F-12. A resolution-independent check: scan the build (fifth trust-config adversary pass)

The fifth pass found two more ways the bundler could load something other than the checked `config.ts` (an
extensionless `config` file; a `package.json` `"imports"` alias reaching `adapter-core`), both proved with a real
`next build`, and one by reading (a module outside `app/src` re-exporting the core). Each is closed by a rule
(extensionless files refused in app/; `imports`/`exports`/`browser` fields refused in `app/package.json`; `#`
specifiers refused; no module files in app/ outside `src` except `next.config.mjs` and `next-env.d.ts`), and the
USDG in `chain.ts` must equal the gate's pinned USDG.

Because each pass found another resolution route, the gate now also checks the **output**: CI runs `next build` and
`trust-config --build app/.next`, which reads every file the build emits (`.next/static`, `.next/server`) and requires
every 20-byte hex address in it to be USDG, the zero address, viem's native placeholder or the trusted factory, and a
set factory to be present. However an import is routed, a hard-coded factory must appear in those bytes, so this
check does not depend on knowing the resolver's rules. The adversary's extensionless-file build is flagged by the
scan alone. Remaining limit: an address assembled at run time from pieces (obfuscation) is out of scope, as before.

## F-13. Addresses inside hex data, app/public, environment variables (sixth trust-config adversary pass)

- The scan matched only `0x`-prefixed literals, so a hard-coded `approve(spender, max)` calldata string hid the
  spender (proved with a real build, `tests/trust-config-bundle-scan-misses.spec.ts`). It now also takes the
  address from every 32-byte word of 24 zero digits plus 40 hex digits inside any hex run (calldata, topics,
  `pad()`), skipping small padded numbers (first 4 address bytes zero). Today's build has three such words, all
  small numbers from library bytecode; none is flagged.
- `app/public` is shipped with the page and can be fetched at run time, so the scan reads it too (and more text
  file types).
- `lib/robinhood`, `lib/core` and `components/robinhood` may not read `process.env` / `import.meta.env`.
- **Decision for review 3 (Joshua):** CI scans CI's build, but Vercel rebuilds `app/` with its own environment.
  With the env rule above, the trust and transaction code cannot take an address from Vercel's environment; the
  remaining gap is only that Vercel's build is a separate build of the same commit. Option: deploy the Robinhood
  page with `vercel deploy --prebuilt` from the CI-scanned build, or accept the separate build given the env rule.
- Bare 40-hex strings with no `0x` and no padding are not matched (the build has Solana-style `111…` runs that
  would false-alarm); turning one into an address takes code that assembles it at run time, which is the stated limit.

## F-14. The deployed page is the scanned artifact (code review r2, MAJOR 2)

CI's build scan only covered CI's own build, while a normal Vercel deployment rebuilds `app/`. The release path is now
**prebuilt**: `ops/release-robinhood.sh` (run by Joshua with his Vercel login, from a clean commit) does `vercel pull`,
`vercel build`, then `trust-config --vercel-output app/.vercel/output --record release/robinhood-prebuilt.json`: every
file of the artifact is scanned (any file type, server functions included; a file over 50 MB or a link that leaves the
artifact fails), and one sha256 over all `path<TAB>sha256` lines is written with the commit. Joshua then runs
`cd app && vercel deploy --prebuilt` (it uploads exactly those files, no rebuild) and records the deployment URL in the
same file. Review 3 checks the record's commit and digest against the reviewed config commit. The record file is
allowed to change after the deployed commit. CI builds the same kind of artifact offline (`vercel@59.11.7 build`) and
scans it, so the gate is exercised on Vercel output on every push. A local run: 778 files, only USDG, zero and viem's
placeholder, stable digest.

## F-15. Everything `vercel deploy --prebuilt` uploads is scanned and fingerprinted (prebuilt adversary pass)

`vercel deploy --prebuilt` also uploads, from `app/` itself, every file listed in each function's `.vc-config.json`
`filePathMap` (`.next/server/**` including the Robinhood page's server code, `node_modules/**`, `package.json`), and the
scan and digest covered only `.vercel/output` (proved with a real offline `vercel build`,
`tests/trust-config-prebuilt-upload-set.spec.ts`). Now `uploadSet` reads every real `.vc-config.json`, resolves each
filePathMap source against the project dir (it must exist and stay in `app/` or `app/node_modules`' real location), and
`scanTree` scans those files and `artifactDigest` fingerprints them (`upload:<key><TAB>sha256`; package links as
`-> target`). Local run: 778 output files + 104 uploaded files + 1 package link, only allowed addresses. The record also
writes `release/robinhood-prebuilt.files.txt` (the per-file list) because a Next build ID is random: a reviewer compares
files, not a rebuilt digest. `--record` and the release script now refuse untracked files (a stray page would be built
in). The script takes `--prod` (a production deploy needs a production build) and warns not to run `next`/`pnpm` in
`app/` between the release scan and the deploy.

## F-16. "My circles" is bounded and cannot be buried by strangers (code review r3, M2; ARB-DESIGN r10)

The page read every circle the factory ever created (5 reads plus one per member for each), so a sybil's thousands of
unrelated circles could stall it before it reached a member's own. Reading the newest N instead loses older circles
(the earlier 40-circle adversary case). ARB-DESIGN r10 adds a per-account index on the factory: `circlesOf[account]`
gets a circle when the account creates it or first joins it (`joinAndLock` calls `factory.recordJoin(msg.sender)`;
`recordJoin` refuses any caller that is not this factory's circle; `listed` deduplicates a leave and rejoin).
Index-at-creation for every named member was rejected: anyone may name a victim in a circle, so that list is
spammable. Views `circlesOfCount` and `circlesOfPage(account, start, count <= 50)`. The page reads it newest first,
10 per page, continuing from an absolute index, with "Show more", a retry, and the error cleared when a request
starts (r3 m1). A circle the wallet was only named in is reached by its invitation link (AL12). Tests: Foundry
`MemberIndex.t.sol` (5), anvil: a joined circle found after 100 strangers' circles, 50 of them naming the victim, in
at most 16 reads; paging 100+ entries with a circle added between pages; reducer spec for the stale error.
Mutations M38-M43 (drop the isCircle check, the dedup, the recordJoin call, the creator listing, the page cap; list the
creator instead of the joiner) all killed. The mutation runner now rebuilds after restoring `src/`: it used to leave
the last mutated build in `out/`, which the anvil specs and the ABI export read.

## F-17. The deploy is part of the reviewed release command (code review r3, M1)

The record described what was scanned, but the deploy was a separate command typed later, so a `next build`,
`pnpm install` or edit in between would upload unscanned bytes under a clean-looking record. `ops/release-robinhood.sh`
now runs `ops/release-deploy.ts` itself, straight after the scan: it refuses unless the record is new, was built with
the pinned CLI, the checkout is the recorded commit with only the record changed, and the upload set (output plus
filePathMap files) hashes to the recorded digest and per-file list; then it deploys with `npx vercel@59.11.7 deploy
--prebuilt`, hashes the set again (a change during the upload voids the deployment and says so), and only then writes
the URL, target and time into the record. The release script and CI use only `vercel@59.11.7` (`VERCEL_CLI` in
trust-config.ts; a test fails on any other pin or an unpinned `vercel pull|build|deploy`). Tests:
`tests/release-deploy.spec.ts` (8), including the mutated-upload refusal with Vercel never run.

### F-17 adversary pass: files the CLI uploads beyond the output and filePathMap

The adversary proved (with the pinned CLI's own collector, `inspectDeploymentFiles`, the function behind
`vercel deploy --dry`) that vercel@59.11.7 also uploads `<app>/.vercel/routes.json` when it exists, which neither the
digest nor `git status` (app/.vercel is ignored) saw. The CLI's `buildFileTree2` adds three such things: that file, any
`microfrontends.json(c)` in the project outside node_modules and .git, and a `bulkRedirectsPath` from the project's
Vercel config. This app uses none, so `cliExtraUploads` refuses each (and any Vercel project config file): in the
scan of a real `<project>/.vercel/output`, and in `release-deploy` before the deploy and again after it (then the
deployment is void; in production the message says to roll back). Kept tests: the adversary's
`tests/release-deploy-uploads-adversary.spec.ts`; release-deploy cases for each extra file and for one written during
the upload; and on the real offline build, every file the pinned CLI's collector lists is inside what the scan and
digest cover (CI installs vercel@59.11.7 globally for it). Also from its suspicions: the pin test now rejects any
`vercel@<spec>` other than the pinned version (`@latest`, ranges) and any bare `vercel` command, each proved by a
mutated script; the deployment URL must be the single `https://<name>.vercel.app` line on stdout.

### F-17 second adversary pass: the compiled config and rootDirectory

The follow-up pass proved (the pinned CLI's own `readLocalConfig` and collector) that with no `vercel.json` or
`vercel.toml` in `app/` the CLI falls back to the compiled `app/.vercel/vercel.json` (ignored by git), whose
`bulkRedirectsPath` adds a file to the upload; and that `settings.rootDirectory` in `.vercel/project.json` moves where it
looks. Listing known extras was the wrong shape, so `cliExtraUploads` is now an allow-list: `app/.vercel` may hold only
what `vercel pull` and `vercel build` write (`project.json`, `README.txt`, `output/`, `node/package-manifest.json`,
`.env.<target>.local`, names only, never read); no Vercel config file of any name (`/^(vercel|now)\.[^.]+$/`) in `app/`;
`rootDirectory` unset; no microfrontends file. `.vercel/project.json` is in the digest, so a change after the record is
refused. The real offline build passes the allow-list (the clean-gate case), and the adversary's spec is kept.

### F-17 third adversary pass: absolute filePathMap sources and the CLI's environment

(1) `uploadSet` read a filePathMap source with `resolve`, the pinned CLI with `join`: for an absolute value the release
hashed `v` while the CLI uploads `<app>/<v>` (proved with the CLI's collector; the adversary's spec is kept). An
absolute source is now refused (no real build has one); relative values behave as before (join and resolve agree).
`release-deploy` also refuses on any upload-set failure before and after the deploy, and a linked source's link text
is in the digest (the CLI uploads the link). (2) `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `VERCEL_TEAM_ID` re-target the
CLI away from the recorded `.vercel/project.json`: the release script and `release-deploy` refuse them, and the deploy
CLI runs with an allow-listed environment (PATH, HOME, locale, XDG, proxy, nvm), so no other `VERCEL_*` switch reaches it.

### F-17 fourth adversary pass: folder links

A filePathMap source that is a link to a folder (the usual pnpm package link) is uploaded as its link text, but the
digest recorded only the folder it resolves to, so a re-written link text with the same target deployed unrefused
(the adversary's spec is kept). The digest now binds the link text of folder links as it already did for file links,
and upload entries are one per source path, as the CLI dedupes them, so a plain file and a link reaching the same
target are two entries (tested). Stated limit, not fixed: the release trusts the operator's machine. A tampered global
Vercel CLI config (`api` in its config under HOME/XDG) could point the CLI at a server that is not Vercel; the digest
and the URL check cannot detect that. Joshua runs the release from his own logged-in machine.

### F-17 fifth adversary pass: modes, empty folders, special files

The pinned CLI sends each upload's mode, and an empty output folder as its own entry; the digest bound neither, so a
`chmod` or a new empty folder after the record deployed unrefused (no bytes changed; the adversary's spec is kept). The
digest now has `path<TAB>sha256<TAB>mode` for files (and the source mode for filePathMap entries) and a `path/<TAB>dir`
line for every output folder. A FIFO or device in the output is refused by the scan and listed, never read, by the
digest (it would have hung); a filePathMap source that is not a regular file or folder is refused.

### F-17 sixth adversary pass: folder modes, a linked output

An empty output folder is uploaded with its mode, which the `dir` line did not carry (a `chmod` deployed unrefused; the
adversary's spec is kept), and a filePathMap folder source likewise. Folder lines now carry the mode. Its suspicion, an
`app/.vercel/output` replaced by a link to a copy (the CLI would upload the link, not the files: a broken deploy), is
refused: `.vercel/output` and `.vercel/node` must be real folders (tested).

### F-17 seventh adversary pass: a linked app/.vercel, names with tabs

A linked `app/.vercel` passed (the digest follows it; the CLI uploads only the link: a broken deploy, no unscanned
bytes; the adversary's spec is kept). `app/.vercel` must now be a real folder, like `output` and `node`. From its
suspicion: digest lines are tab-separated, so a file or filePathMap name with a tab or line break is refused.

### F-17 eighth adversary pass: the digest's line format itself

The digest is a sorted list of tab-separated lines, and a linked filePathMap source's link text went in raw, so a link
whose text held a line break could forge the line of a file added later: an added output file then left the digest
unchanged (the adversary's spec is kept). The class is closed at its root: every free-text field (paths, keys, link
text, real paths) goes through `esc` (backslash first, then every control character as `\xNN`), so no name can carry a
raw tab or line break into a line and distinct names stay distinct (tested); ordinary names are unchanged. The name
refusals stay as a second layer and now include link text and real paths.

### F-17 ninth adversary pass: a linked .vc-config.json; line namespaces

The escaping was confirmed injective. In older code, `uploadSet` skipped every link while walking the output (for
linked `.func` folders), but the CLI picks configs by the name `.vc-config.json` and follows a linked one, uploading
the sources it names: those were never digested (the adversary's spec is kept). A linked `.vc-config.json` is now
refused (the real build has none). From its suspicion: upload and project lines now start with `/`, which no relative
output path can, so an output file named `upload:…` cannot stand in for an upload line (tested).

### F-17 tenth adversary pass (a full rule-by-rule table): project.json repoRoot

Asked for a systematic table (each rule the pinned CLI uses to choose uploads against its digest line or refusal), the
pass found every rule covered except one: `repoRoot` (or `projectRootDirectory`) in `app/.vercel/project.json`, which
the CLI honours by switching its cwd and output directory, so a record written with it present deployed another
folder (the adversary's spec is kept). `project.json` may now hold only the keys `vercel pull` writes (projectId,
orgId, projectName, settings), and a `.vercel` folder at the repository root (which can move the CLI's project root)
is refused by the release script and by release-deploy.

### F-17 eleventh adversary pass: a repo link above the project

The pinned CLI's `findRepoRoot` looks for `.vercel/repo.json` in every folder above `app/`; with a `project.json`
holding only `settings` (what `vercel pull` writes for a repo-linked project), a planted ancestor `repo.json` moved the
deploy to a folder never scanned (the adversary's spec is kept). The release now refuses a `.vercel/repo.json` in any
folder above the project, and a `project.json` without both `projectId` and `orgId`.

### F-17 twelfth adversary pass: a Vercel config at the repository root; local CLI copies

The pinned CLI's `resolveProjectCwd` finds the git root and turns services mode on from a `vercel.json`, `vercel.toml`
or `vercel.ts` there, then reads the link from the root and ignores `app/.vercel/project.json` (the adversary's spec is
kept). From its suspicions: a root `vercel.ts` is compiled with the root `.env` files loaded (around the env
allow-list), and `npx vercel@59.11.7` would run a local `node_modules/vercel` instead of the registry's pinned CLI.
`repoRootRefusals` (release-deploy) and the release script now refuse, by name so no git exclude hides them: a root
`.vercel`, any root Vercel config (`vercel.*`, `now.*`, any case), and a `vercel` package or bin in the root's or app's
node_modules. The real repository has none of them.

### F-17 thirteenth adversary pass: npx runs a planted versioned bin (branch task/A1-r4-cli-pin)

`npx --yes vercel@59.11.7` first runs any file named `node_modules/.bin/vercel@59.11.7` in the working folder or above
(npm 10's libnpmexec), so a planted one in the gitignored `app/node_modules/.bin` ran instead of the pinned CLI for
pull, build and deploy. The release no longer runs Vercel through npx at all: `ops/vercel-cli/` holds a package.json and
a committed lockfile for `vercel@59.11.7` (388 entries, every one with its registry integrity); `release-deploy
--install-cli` does `npm ci --ignore-scripts` of it into a fresh empty folder and `verifyPinnedCli` checks the installed
lock is byte-identical to the committed one, the `vercel` entry is `VERCEL_CLI` at `VERCEL_CLI_INTEGRITY`, the installed
package is that version, and `dist/vc.js` is a regular file; the script then runs `node "$VC" pull|build`, and
`deployRecorded` runs `node <vc.js> deploy --prebuilt` only after re-verifying that install (without one it refuses).
CI's offline build and the real-build spec use the same installer, so a real Next build from the lockfile install with
scripts off is proved on every push. The adversary's spec is kept with its last assertion adapted to this fix: the one
command run is node with the verified vc.js, never npx. Stated limit (with the tampered-machine one): the checkout's own
`node_modules` from `pnpm install --frozen-lockfile` is trusted, since the checks themselves run with its tsx.

### F-17 fourteenth adversary pass: a builder planted in app/.vercel/builders

The pinned CLI's `build` loads each builder first from `app/.vercel/builders/node_modules/<name>` when its version
string matches, and only then its own locked dependency (proved by running the real release with the real build). The
scan would refuse that folder afterwards, so nothing planted could deploy, but unlocked code would already have run.
The release now treats `app/.vercel` as build state: it keeps only the project link, removes the rest, and `--preflight`
checks the repo root, `app/.vercel` and the link (keys, ids) before anything is installed or built. Pull and build run
through `release-deploy --run-cli`, which re-verifies the pinned install and gives the CLI the same allow-listed
environment as the deploy (no `VERCEL_*`, `NODE_OPTIONS`, `ESBUILD_*` or builder-directory switch). A real build
through that path completes (1,073 output files, gate and preflight pass). The adversary's spec is kept, made
hermetic (an `npx` shim skips only the pull and deploy steps, HOME is empty so no Vercel login exists) and with a
second check that the locked `@vercel/next` did run.

### F-17 fifteenth adversary pass: gitignored files in the checkout take part in the build

`next build` loads `app/.env.production.local`, `.env.local`, `.env.production` and `.env` on its own and inlines every
`NEXT_PUBLIC_*` into the client chunks; all are gitignored, so a developer's local env file shipped to every browser
under a clean record (proved with a sentinel RPC URL). It also found that nothing created `release/`, so the release
failed on a fresh checkout, and that `app/.next/cache` survived the reset. The class, gitignored state in the working
checkout, is now closed structurally: the release checks the checkout (clean, no re-targeting env, no `NODE_OPTIONS`,
pnpm 10.32.1, a project link), then clones that commit into a fresh temporary folder (`git clone --no-local`,
`checkout --detach`), copies in only the project link, installs root and app dependencies with `pnpm install
--frozen-lockfile --ignore-scripts`, and runs every later step there (preflight, the verified CLI install, pull and build
through `--run-cli`, `mkdir -p release`, scan and record, deploy); only the record and its file list are copied back.
Nothing gitignored in the working checkout exists in the clone, and the checks themselves now run with freshly installed
dependencies. The adversary's spec is kept, adapted: the sealed harness (tests/release-script-harness.ts) copies exactly
the folder that would be uploaded before skipping the deploy, the spec searches that copy, and it no longer creates
`release/` itself; it also asserts the release completed and reached its deploy step with an output.

### F-17 sixteenth adversary pass: configuration through environment variables

The script refused `NODE_OPTIONS` but every step after the clone started through `npx`, and npm turns its `node-options`
setting, read from `npm_config_node_options`, into `NODE_OPTIONS` for what it runs: a preload planted `app/.env.local`
inside the fresh clone and the build inlined it (the adversary's spec is kept). Its suspicions were the same class
through git (`GIT_TEMPLATE_DIR`, `GIT_CONFIG_*` hooks) and pnpm (`npm_config_global_pnpmfile`). Closed as a class: the
script refuses the re-targeting VERCEL_* ids and `NODE_OPTIONS`, then re-runs itself under `env -i` with only PATH,
HOME, user, shell, terminal, locale, TMPDIR, XDG, proxy, nvm and ROBINHOOD_RPC, so every `npm_config_*`, `GIT_*`,
`NODE_*`, pnpm and VERCEL_* variable is gone; git in the clone runs with no system or global config, an empty template
and no hooks; pnpm runs with `--ignore-pnpmfile`; and the checks run with the clone's own tsx started by node, so no step
goes through npx. The kept spec now sets the npm, git-template, git-config-hooks and pnpmfile variables together. The
sealed harness stubs pull and deploy with a `node` shim and links only the pnpm store and npm cache into its empty HOME.
Also: the adapter spec's viem client polls every 250 ms (a missed first receipt check had cost 4 s per transaction in
CI, timing the end-to-end test out).

### F-17 seventeenth adversary pass: what lies above the clone; the seal flag

(1) The clone sat in `$(mktemp -d)` under the shared `/tmp` (or `$TMPDIR`), and `next build` requires packages it does
not install (`@opentelemetry/api`), which node resolves from any `node_modules` in a folder ABOVE the clone: a module
planted in `$TMPDIR/node_modules` ran in the build and its value was uploaded under a clean record. (2) The seal trusted
its own flag: `RELEASE_ENV_SEALED=1` in the caller's environment skipped it, and a `GIT_CONFIG_COUNT` smudge filter (with
a matching clean filter to blind the dirty check) rewrote the clone. Fixes: the build folder is private, under
`$HOME/.cache/othello-release` (mode 700), never the shared temp; `--preflight` refuses any of node_modules,
package.json, pnpm-workspace.yaml, a pnpmfile, PostCSS, Browserslist, Babel, SWC, tsconfig/jsconfig, .npmrc or yarnrc in
any folder above the clone (this machine has none); after re-running itself the script checks that the environment
holds nothing but the allowed variables and bash's own, whatever the flag says; and it releases the repository it
belongs to, wherever it is run from. The adversary's spec is kept with a third case added (a node_modules in HOME,
above the new build folder, is refused before anything is built).

### F-17 eighteenth adversary pass: tsx's transform cache in the shared /tmp

Every check step runs through tsx, which caches each transformed file in `os.tmpdir()/tsx-<uid>` and later runs the
cached code; TMPDIR was allowed and defaults to the shared `/tmp`, so another local user who creates that folder first
can rewrite a cached `trust-config.ts` or `release-deploy.ts` and run their code in the scan or the deploy check (proved
with a watcher process and a scratch TMPDIR; the adversary's spec is kept). After creating its private folder the
script now sets `TMPDIR="$WORK/tmp"` (mode 700) for every later step (tsx, npm, pnpm, next), and tsx runs with
`--no-cache`. Stated limit, recorded: the caller's shell (e.g. `BASH_ENV`, which bash runs before the script's first
line) is the release account's own environment, like PATH and HOME; the script cannot defend against it from inside.

### F-17 nineteenth adversary pass: no defect; two suspicions closed

The pass found no defect (tsx's cache and IPC, the CLI's and Next's temp paths, build-utils' PATH entry, config above
the clone, and falsifying the record all failed). Its two suspicions are closed anyway: the private folder and
`TMPDIR` are now set before any tool runs (`pnpm --version` could otherwise leave node's compile cache in the shared
/tmp); and the record now carries `deployStartedAt`, written before Vercel is contacted, while the EXIT trap copies
any record the clone wrote back to the checkout on every exit, so an interrupted or failed deploy is never invisible;
a record whose deploy started is refused a second deploy ("check Vercel, then build a new release").

### F-17 twentieth adversary pass: a failed scan must not replace the committed record

trust-config wrote its record before verifying a set TRUSTED_FACTORY against the chain, and the new EXIT trap copied
any record back, so a run whose chain check failed replaced the checkout's record of the last real deploy (the
adversary's spec is kept, its precondition adapted). Now trust-config writes the record only after every check has
passed; the trap copies back only a record that reached the deploy step (it carries `deployStartedAt`), and a failed
copy cannot stop the clean-up; the deploy-failure message no longer claims the record is unchanged. Running that spec
exposed that a fresh clone has no `evm/out`, which trust-config needs to verify a set factory: when the factory is set,
the release now fetches the libraries at the commits the repository pins (`git submodule update --init`, no hooks or
templates) and runs `forge build` inside the clone, never using the working checkout's `evm/out`.

### F-17 twenty-first adversary pass: a failed copy-back must not lose a completed deploy's record

If copying the record back to the checkout failed after a completed deploy (a read-only committed record, a full
disk), the trap printed a line and deleted the build folder anyway: the only record of that deploy was lost and the
release exited 0 (the adversary's spec is kept; its deploy step runs the clone's real deployRecorded with only the
Vercel call replaced). Now a failed copy KEEPS the folder, names the record's path and fails the release. From its
suspicions: the contracts are built with `forge build --force` (no committed or cached output reused); whether the
factory is set is asked of trust-config's own parser (`--config-state`), not matched as text; and that build now runs
after `--preflight`.

### F-17 twenty-second adversary pass: no defect; two record suspicions closed

The pass found no defect (every exit path, the copy-back, `--config-state`, errexit inside the trap). Two of its
suspicions are closed: the record is now replaced whole (written beside it, then renamed), so a crash never leaves it
half-written and unreadable by the copy-back check; and a deployment voided because files changed during the upload is
now named in the record (`voidedDeploymentUrl`), so it can be found and removed.

### F-17 twenty-third adversary pass: the check after the upload must not lose a live deployment's URL

Low severity: if the output folder vanished during the upload, the second `artifactDigest` threw, so a known and
possibly live URL never reached `voidedDeploymentUrl` and nobody was told to roll it back (the record still said a
deploy started, so it did not lie; the adversary's spec is kept). The check after the upload now treats any error as a
voided deploy: the URL is recorded as voided and the message says to remove it or, in production, roll back.

## F-18. The release deploys only to the reviewed Vercel project (code review r4, F1)

Codex r4 (REVISE; r3 M1, M2 and m1 RESOLVED): the release copied the caller's `app/.vercel/project.json` into the clone
and required only non-empty ids, so a stale link to another project the operator can deploy to (no compromise needed)
would pull, build and deploy the reviewed page there with every check passing; the digest bound the chosen link, not
the right one. `ops/release-target.json` (committed, reviewed) now names the one Vercel team and project
(`team_kXXQhD4pqG6KG2NfVVFlVOHi` / `prj_ZCQ6bP09jJeMX1wOwg7ErhJe8wB8`, project "othello"); `releaseTargetRefusals`
refuses any other `orgId` or `projectId`, a missing target or a missing link, in `--preflight`, which the release runs
before `vercel pull` and again after the build, before the scan and record. The sealed specs commit a test target in
their own clone. Also (queued from the last adversary pass on b52d03f): if the voided-deploy record cannot be written,
the URL and the remove/roll-back instruction still reach the operator (spec kept).

### F-18 adversary pass: the deploy step checks the target too

The first fix checked the target only in `--preflight`; `release-deploy.ts --record`, the deploy entry point every
record names, can be run on its own, and it started `deploy --prebuilt --prod` against a stale link (the adversary's spec
is kept). `deployRecorded` now runs `releaseTargetRefusals` with the other pre-deploy refusals, reading the committed
`ops/release-target.json` (a missing one is a refusal); unit specs, which build their own release folders, pass the
target matching their link (tests/fake-pinned-cli.ts `reviewedTarget`), and a deploy-time mismatch and a missing target
are tested. Its unproven suspicion, noted: if the linked project were inaccessible, `vercel pull --yes` might link
another project and pull its settings into the private build folder; the second preflight then refuses before any
scan or deploy, so nothing is deployed and the folder is deleted.

### F-19 adversary pass on be54588: the CLI runner checks for itself

`release-deploy.ts --run-cli` (the release's pull and build) is an entry point of its own, like `--record`, and started
the pinned CLI for `pull` against a link to another project (another project in the reviewed team, or the reviewed
project id under another team; the adversary's spec is kept). `execPinnedCli` now starts only the release's four
argument lists word for word (pull preview/production, build with or without --prod), so no deploy, link, env or
promote command and no global flag (--cwd, --scope, --token, --local-config, --global-config) reaches the CLI; it
always runs in the checkout's app folder (`--cwd` other than `app` is refused); and it runs the full preflight (the
reviewed target first) before starting, so the release's own pull and build are each checked, not only the script's
separate `--preflight` calls. A `null` target file or link is now a refusal instead of a TypeError (it already stopped
before Vercel). Noted, not changed: a standalone `--record` in an operator checkout reads the working-tree target, so a
file hidden with `git update-index --skip-worktree` would pass; the same trick could alter release-deploy.ts itself,
and the release proper runs from a fresh clone of the commit, where no such bit exists.

### F-20 adversary pass on 222e3fc: the target is read from HEAD

The reviewed input is the committed `ops/release-target.json`, but `releaseTargetRefusals` read the working-tree copy,
so an uncommitted edit naming another project, with app/ linked to it, passed `--run-cli`'s preflight and the pinned
CLI started `pull` against an unreviewed project (nothing could be uploaded: `--record` refuses a changed tree; the
adversary's spec is kept). The target is now read with `git cat-file blob HEAD:ops/release-target.json` in a checkout
whose top is the release root, and the working-tree copy must be the same text; a file never committed, an edited copy,
or a root below another checkout's top is a refusal. Every entry point therefore also requires a git checkout at the
release root, which closes the adversary's unproven note that, without a `.git` there, the CLI looks for `.vercel` or
`vercel.json` in folders above. Unit specs that mean "the committed target" now commit it (tests/fake-pinned-cli.ts
`commitTarget`); the two earlier target adversary specs commit theirs, keeping each test's meaning.

### F-21 adversary pass on 9b44681: the release's git answers only about the root's own commit

`committedTarget` asked git for `HEAD:ops/release-target.json` with replace refs on and the caller's environment
inherited: a local `git replace <HEAD> <commit naming another project>` (HEAD and `git status` unchanged) let `--run-cli`
start `pull` against an unreviewed project, and `GIT_DIR` pointing at another repository let an uncommitted target
edit pass `--preflight` (the adversary's spec is kept). Both need write access to the checkout, and the sealed release
was unaffected (env -i, a fresh --no-local clone), but the entry points run by hand were not. Every git call of the
release (the target read, the deploy's HEAD and changed-file view, trust-config's record and reviewed-source checks)
now goes through `gitIn`: only PATH and HOME, no system or global config, `--no-replace-objects`, and a
`GIT_CEILING_DIRECTORIES` at the root's parent, so git never answers about a repository above or beside the root. Unit
cases: a replaced HEAD shows the target as changed to the deploy and is refused by the target check; `GIT_DIR` and
`GIT_WORK_TREE` in the environment are ignored; a checkout above the root, or one whose `core.worktree` points
elsewhere, is no reviewed target.

### F-22 adversary pass on 49ec527: git gets no HOME, and the repository's own settings cannot redirect it

`gitIn` still passed HOME, and git reads the user-global ignore file `$HOME/.config/git/ignore` (core.excludesFile's
default) even with `GIT_CONFIG_GLOBAL=/dev/null`: a caller who sets or owns HOME hid an untracked page from the
deploy's changed-file check and from trust-config `--record`'s dirty check, with no write access to the checkout (the
adversary's spec is kept). `gitIn` now passes only PATH, names the repository and working tree explicitly
(`--git-dir=<root>/.git --work-tree=<root>`, so a repository's `core.worktree` cannot move what is compared), and
overrides on the command line `core.excludesFile` and `core.attributesFile` (/dev/null), `core.fsmonitor` (false, so no
configured program runs), `core.untrackedCache` (false), `core.hooksPath` and `status.showUntrackedFiles=all`. Unit
cases: a foreign `core.worktree` with the committed copy elsewhere still refuses an edited target at the root; a
configured fsmonitor never runs; `status.showUntrackedFiles=no` does not hide an untracked page. Checked in a linked
worktree (`.git` is a gitdir file): HEAD, top, status and the committed target all resolve. Accepted and stated: a
repository's own `.git/info/exclude` needs write access to the checkout, like editing the release code itself, and the
sealed release runs in a fresh clone that has none.

### F-23 adversary pass on 647e485: the build's inputs are checked by content, not by git's status

`git status` rests on ignore rules, the index's stat cache and repository settings. An untracked `.gitignore` containing
`*`, written beside an unreviewed page, hid the page and itself from the deploy's changed-file check and from
trust-config `--record`'s dirty check with nothing but the working-tree write that placed the page; the repository's
own `core.trustctime=false` let a same-size in-place edit pass, and `core.ignoreCase=true` hid `Page.tsx` beside
`page.tsx` (the adversary's spec is kept; its "dirty check" assertions now name `uncommittedPaths`, the function
`--record` uses). New `sourceDrift` (trust-config.ts) reads HEAD's tree with `ls-tree` (through gitIn) and hashes, as git
would store them, every file under app/ and every file at the repository root (Next looks upward for some build
configs), except what the build itself writes (`NOT_SOURCE`: app/node_modules, app/.next, app/.vercel, Next's
generated `next-env.d.ts` and `tsconfig.tsbuildinfo`): a file not in HEAD, with other bytes or kind, or missing is
reported, with no ignore rule, cache or setting involved. `uncommittedPaths` (status with every untracked file, plus
sourceDrift) is now the deploy's `changed()` and `--record`'s dirty check; gitIn also pins `core.trustctime`,
`core.checkStat` and `core.ignoreCase`. Noted, unchanged: `release-robinhood.sh`'s first `git status` runs in the
operator's checkout before the fresh clone; untracked files there never reach the clone, which holds only the commit
plus the checked project link.

### F-24 adversary pass on 3b651eb: a linked worktree's `.git` file is not a build input

`sourceDrift` checked every root-level non-directory entry, and in a linked git worktree the root `.git` is a
`gitdir:` file no commit holds, so every clean worktree was refused (a false refusal: nothing wrong could be deployed;
the sealed clone and CI have a `.git` folder; the adversary's spec is kept). The root `.git` is now skipped, and the
root `node_modules` joins `NOT_SOURCE` beside `app/node_modules` (an install folder; a link to one in these worktrees).
Stated limit, now in `NOT_SOURCE`'s comment: install and build-cache folders (`node_modules`, `app/.next`, including
Next's cache) are trusted because the sealed release creates them fresh from the committed lockfiles in its clone; in
a checkout run by hand they are whatever is on disk, and only the upload set's hash and record bind what is deployed.

### F-25 adversary pass on 5ed06d3: git's paths are compared exactly

`deployRecorded` normalised every changed path (`\` to `/`) before dropping the record and its file list, so a root file
named `release\robinhood-prebuilt.json` (reported by `sourceDrift`, hidden from `git status` by a line in the
repository's own `.git/info/exclude`) was taken for the record itself (cosmetic: only the two allowed names, `.git`
write access, and `trust-config --record` still refused it; the adversary's spec is kept). Git's paths are now compared
as git gives them; only the release's own two paths are normalised. Also found, not changed: these development
worktrees link `node_modules` and `app/node_modules`, which `git status` lists (the `.gitignore` pattern
`node_modules/` matches folders only), so a hand-run record or deploy in such a worktree is refused; release
checkouts and the sealed clone have real folders. No new exemption was added for it.

### F-26 adversary pass on 975dc76: the record's file list is pinned to the record's sibling

No defect in the path comparison; the pass's suspicion held: `rec.fileList` came from the record, and it is the second
path the deploy lets change, so a hand-written record could name an unreviewed source file there and exempt it from the
changed-file check. deployRecorded now requires the record to be a `.json` file and its file list to be exactly
`<record>.files.txt` beside it (as writeRecord writes it), and refuses before the CLI starts otherwise (unit case with a
record naming `app/src/app/unreviewed/page.tsx`).

## F-27. The Vercel project's build settings are reviewed input; git is sealed from its first call (code review r5)

Codex r5 on 5e78c4c (REVISE; r4 F1 RESOLVED: the destination is an authorised input). **F1 MAJOR:** `vercel pull`
writes the project's settings into `app/.vercel/project.json`, and the pinned CLI's build (59.11.7) runs
`settings.installCommand` and hands `buildCommand` and `outputDirectory` to the builder, in a folder that already holds
the pulled env files; both preflights accepted any settings but `rootDirectory`, so a stale or changed setting on the
right project ran unreviewed code before the scan, which then faithfully bound its output. `ops/release-target.json`
now carries the reviewed settings document (`vercelSettings`); the code accepts only a document that runs nothing of its
own (framework nextjs; no build, dev or output override; no root directory; the install step skipped, `""`, so the
dependencies are only the release's frozen --ignore-scripts install; directory listing off; only `nodeVersion` is the
project's), and from the pull on the link's settings must be exactly that document: the build runner refuses before the
CLI starts, and the post-build preflight and the deploy refuse too. Keys the pull never writes (`monorepoManager`, which
the build reads) and Web Analytics' `analyticsId` are refused. CI's offline build writes its link from that document.
**F2 MINOR:** the script's first `git rev-parse` and both `git status` calls ran before global git configuration was
turned off, so a `core.fsmonitor` program named by the preserved HOME's (or XDG_CONFIG_HOME's) config ran (confirmed:
a plain `git status` runs it). The variables are now exported before the first git call and every call is `safe_git`
(no replace refs, fsmonitor, untracked cache, hooks, user ignore or attributes file); the fresh clone keeps hooks and
fsmonitor off in its own config; and the CLI's own git calls (the deploy's `git status`/`git log` for its metadata) run
with no system or global configuration (`deployEnv`). Specs: tests/release-deploy-vercel-settings.spec.ts (unit), and
two that run the real script sealed: tests/release-script-pulled-settings.spec.ts (the pinned CLI runs a planted install
command; the release never starts the build on it) and tests/release-script-global-git-config.spec.ts (a planted
fsmonitor in HOME and XDG config runs on a plain `git status` and never during the release).

## F-28. The release target is the othello-chains project (the target change r5 asked to review after F1)

Joshua's decision (2026-09-30): a new Vercel project `othello-chains` in the same team (`team_kXXQhD4pqG6KG2NfVVFlVOHi`),
no Git connection, blank Root Directory, env values set only in Vercel, a fresh SWAP_BINDING_SECRET; `othello` stays
frozen for Stocklana (and its Root Directory `app` would be refused by the release anyway). Created 2026-10-01 through
the Vercel API with the logged-in CLI (`vercel api`, no token handled): `prj_4f0tXAiMfVCi5qrIxJVJkT8p05Ki`, framework
nextjs, install command `""` (set by PATCH: the create call stores `""` as null), no build/output/dev override, no root
directory, directory listing off, Node 22.x, Web Analytics off. `vercel link` in app/ wrote the ids; `vercel pull
--environment=preview` wrote the settings, and releaseTargetRefusals with these ids and the committed vercelSettings
returns no refusal (the pulled document is the reviewed one exactly, including `installCommand: ""`). Env: only
SWAP_BINDING_SECRET (Secret type, Production and Preview, each a fresh `openssl rand -hex 32` piped into `vercel env
add`, never displayed); MAINNET_RPC_URL and DEVNET_RPC_URL unset (the app falls back to the public endpoints);
NEXT_PUBLIC_SOLANA_RPC unset (anything NEXT_PUBLIC_ is inlined into the bundle). Deployment protection as created:
`ssoProtection.deploymentType = all_except_custom_domains` (Joshua decides the public policy before the release).
ops/release-target.json now names this project; the spec pinning the committed ids follows.

## F-29. Adversary pass on ce04cd9: the pulled project variables, git filter drivers, the Node.js pin

Two defects, each proven against the real ops/release-robinhood.sh in the sealed harness (specs kept:
tests/release-script-pulled-env-program-adversary.spec.ts, tests/release-script-repo-filter-adversary.spec.ts).
**MAJOR:** `vercel pull` also writes the project's Environment Variables to `app/.vercel/.env.<target>.local`, and the
pinned build loads that file into the environment of pnpm, next and every worker (build/index.js dotenv); a project
variable `NODE_OPTIONS=--import=<module>` ran that module 49 times in one release with every pulled value in reach, and
the release deployed. Fix: after the pull, `ops/release-deploy.ts --drop-pulled-env` runs the pulled-stage target and
settings check, then reads each pulled file's variable NAMES only (values are never read into anything, printed or kept)
and refuses any name that is neither in the reviewed `vercelEnvNames` (DEVNET_RPC_URL, MAINNET_RPC_URL,
SWAP_BINDING_SECRET; the code refuses NODE_*, NEXT_PUBLIC_*, NPM_CONFIG_* and Vercel's own names there) nor one Vercel
writes itself (VERCEL, VERCEL_*, TURBO_*, NX_DAEMON): the project would hand such a variable to the deployed functions
too. Then it removes the files, so the build loads no project variable (none is needed: the server reads its variables
at request time, Secret values are not even downloaded, a NEXT_PUBLIC_ value would be inlined). The build runner, the
post-build preflight and any hand-run `--run-cli build` refuse while such a file exists. **MINOR:** a filter driver in
the repository's own config (`filter.<x>.clean`, selected by .git/info/attributes) ran on the first `git status`; no -c
switch turns drivers off. The script and every TypeScript git call (gitIn, and the preflight's message) now refuse a
repository whose config (includes followed) names a filter, textconv/external diff or merge driver. **Suspicion
confirmed:** app/package.json `engines.node ">=22"` outranks the project's Node.js setting (the release log said 24.x
would be used); app/package.json now pins `"22.x"` and the preflight requires it to equal the reviewed nodeVersion.

## F-30. Second adversary pass, on 4570ded: a submodule's own filter driver; a repository pager

Both proven against the real script in the sealed harness (specs kept: tests/release-script-submodule-filter-adversary.spec.ts,
tests/release-script-repo-pager-adversary.spec.ts). (1) The clean-checkout `git status` ran a status inside every
initialised submodule, which reads that submodule's own config (`.git/modules/<path>/config`): a filter driver planted
there ran, and F-29's driver check reads only the superproject's config. Submodules are no build input here (the fresh
clone initialises its own from the commit's pinned gitlinks; an index-only gitlink change is not in HEAD, which is what
is cloned), so the script's two status calls and `uncommittedPaths` now pass `--ignore-submodules=all` and never look
into one. (2) `safe_git status --short >&2` on a terminal started the pager named by the repository's `core.pager`
(`pager.status=true`): safe_git and gitIn now pass `--no-pager`. Passed (the report's list): every pulled env file name
and value-parsing trick, the pull's key merge, a write between the drop and the build, extra settings keys, the
flags-definitions fetch, driver case/include tricks, the engines pin. Stated limit (the pass's unproven suspicion):
`--record` run on its own checks the target, settings and the recorded bytes, not the project's variables at that
moment or the output's function runtime; the documented route runs it right after the build whose preflight did, and a
variable added in Vercel after the pull is outside what any release check can see (a snapshot, like the settings).

## F-31. Third adversary pass, on 1e196ff: `--ignore-submodules=all` hid a staged gitlink

`all` also drops added and removed gitlink entries from git's HEAD-to-index comparison, so a nested repository staged
under app/ (`A app/src/app/extra`) no longer stopped the release, which then ran to the end (the deployed bytes were
still HEAD's, but the operator's staged page silently did not ship; spec kept:
tests/release-script-staged-gitlink-adversary.spec.ts, which passes on 4570ded and failed on 1e196ff). Now `dirty`
on the script's two status calls and in uncommittedPaths: it never starts a status inside a submodule's work tree (so
no submodule config is read) and still reports added, removed and moved gitlinks. Checked directly on git 2.43.0: with
a planted clean filter in a submodule's own config, a plain `git status` ran it and `--ignore-submodules=dirty` did not;
with a staged nested repository, `dirty` printed `A  app/extra` and `all` printed nothing. Passed (the report's list):
the pager on every route, submodule configs on every other git call, a tracked file replaced by a nested repository
(`T`), an untracked nested repository (`??`), a staged bump of evm/lib/* (no build input; the clone uses HEAD's gitlinks),
`update=!cmd` in .gitmodules (git ignores it).

## F-32. Fourth adversary pass, on d39ec27: a gitlink git cannot open reads as unchanged (low)

With `--ignore-submodules=dirty`, git still opens each submodule to read its HEAD (reading, not running, its config),
and treats one it cannot open (an unknown `extensions.*` in that submodule's config, a dangling .git file, an unborn
branch) as unchanged: a root gitlink checked out away from its pin passed the clean check and the release deployed
(deployed bytes still HEAD's: the clone builds HEAD; low; spec kept: tests/release-script-retargeted-gitlink-adversary.spec.ts).
Rather than ask git about other repositories at all, a gitlink is now allowed only under evm/lib/ (the contracts' two
pinned libraries, no build input here, which the clone initialises from HEAD's gitlinks): the script refuses any other
gitlink in HEAD or the index (read from `ls-tree`/`ls-files`, which open no submodule), and uncommittedPaths reports
each as a change. A failing `git status` now stops the script instead of reading as "clean" (the pass's suspicion).
Passed (the report's list): every program-running key in a submodule's config under `dirty` (fsmonitor, filters,
textconv, external diff, pager, hooksPath, sshCommand, askPass), status.submoduleSummary, staged/removed/type-changed
gitlinks, `submodule.<name>.ignore`, a corrupt index.

## F-33. Fifth adversary pass, on 12f1cb7: a tree read lazily fetched through a configured upload-pack

In a partial clone (a promisor remote, `extensions.partialClone`) missing a tree of HEAD, the new `ls-tree -r HEAD`
asked the promisor remote for it, which started the program named by the repository's `remote.origin.uploadpack`; the
release then deployed (deployed bytes HEAD's; spec kept: tests/release-script-lazy-fetch-adversary.spec.ts, which passes
on d39ec27, where the clone stopped with lazy fetching disabled). Fix: `GIT_NO_LAZY_FETCH=1` for every git call (the
script's export, gitIn's environment, deployEnv for the CLI's git; honoured by this git, 2.43.0-1ubuntu7.3), and the
refused-config list now also names the fetch-time programs and a partial clone (`remote.<x>.uploadpack|receivepack|
promisor|partialclonefilter`, `extensions.partialclone`, `core.sshcommand|gitproxy|askpass`): a release checkout is an
ordinary full clone. Also (the pass's second item): the tree and index reads are captured on their own, so a failing
one stops the release instead of being hidden by the pipeline's `|| true`. Passed (the report's list): quoted paths in
non -z output (never match `^evm/lib/`; a quoted path under it is refused, costing only a release), `..` path parts
(git refuses them), `status="$(...)" || {...}` under set -e, assume-unchanged/skip-worktree (noted before; the build
uses the fresh clone).

## F-34. Sixth adversary pass, on a76e46a: an empty driver name; a normal clone still releases

A repository may name a driver "" (`[filter ""]`, listed as `filter..clean`, selected by an attribute `filter=`): the
refused-config pattern required at least one character in the name (`.+`, from ce04cd9), so the release's first status
ran the program (once the release still reached its deploy step). The pattern now matches `.*` for every driver and
remote name, in the script and in GIT_PROGRAM_DRIVERS (spec kept: tests/release-script-empty-driver-name-adversary.spec.ts,
release and gitIn cases; unit keys added: filter..clean, diff..textconv, merge..driver, remote..uploadpack). The pass
also kept a positive spec, tests/release-script-normal-clone-adversary.spec.ts: an ordinary full clone with both
evm/lib submodules initialised and GitHub URLs releases end to end (nothing fetched). Passed (the report's list): the
clone --no-local source side (uploadpack.packObjectsHook, core.alternateRefsCommand with real alternates, sshCommand,
gitProxy, credential.helper, gpg.program with log.showSignature, pager, editor, diff.external, fsmonitor, bundle URIs:
nothing ran), lazy fetch, the Vercel CLI's git calls, the regex against this repository's real config (no match), and
the tree and index reads failing.

## F-35. Seventh adversary pass, on cf03f94: the locale hid a driver name

The script keeps LANG/LC_ALL (Ubuntu's default C.UTF-8), and under a UTF-8 locale git's regex `.` matches no byte that
is not valid UTF-8, so `config --get-regexp` did not list `filter.\xff.clean`; the first status ran it and the release
deployed. gitIn (PATH only, so the C locale) did list it: the two copies disagreed (spec kept:
tests/release-script-non-utf8-driver-name-adversary.spec.ts). Every safe_git call now runs with `LC_ALL=C`, and gitIn's
environment names `LC_ALL=C` explicitly. Passed (the report's list): empty, dot, space, quote, case and valid unicode
names; no false positive on an ordinary clone; the two widened specs are not vacuous (each refusal message is printed
only on a refusal, and each spec also asserts the exit, the sentinel and the upload).

## F-36. Eighth adversary pass, on 86afb72: grep read git's output in the caller's locale

86afb72 ran git in the C locale, but the script's own `grep`/`cut`/`sort` read git's output in the caller's locale. With
the repository's `core.quotePath=false`, ls-tree and ls-files print a path's raw bytes, and under a UTF-8 locale GNU grep
drops a line that is not valid UTF-8 ("binary file matches" on stderr), so a gitlink at `vendor\xff` passed the
nested-repository check (refused under LC_ALL=C; the release then stopped only at the trust-config scan, on an ENOENT for
the undecodable name; nothing deployed; spec kept: tests/release-script-locale-gitlink-grep-adversary.spec.ts). Now the
script exports `LC_ALL=C` right after its environment seal, so every tool after it matches and parses in the C locale,
and safe_git passes `-c core.quotePath=true`, so git escapes such bytes and its output is plain ASCII. Passed (the
report's list): the two refused-config copies are byte-identical once unescaped; LANGUAGE and LC_* cannot override
LC_ALL=C; NUL and newline in a driver name (git refuses or never reaches them); spaces in a name; status parsing; no git
call outside safe_git or gitIn. Stated limit (the pass's unproven suspicion): trust-config decodes git's `-z` output
and directory names as UTF-8, so a path that is not valid UTF-8 becomes U+FFFD; the observed effect is a failed lstat
(the release stops), not a pass.

## F-37. Ninth adversary pass, on 7552f17: the environment check's locale; CI triggers; a stated limit

(1) `export LC_ALL=C` came after the environment check, whose grep ran in the caller's locale: under C.UTF-8 an extra
variable whose name is not valid UTF-8 was dropped by grep and passed the check it fails under C (spec kept:
tests/release-script-locale-env-seal-adversary.spec.ts). The export now comes before that check (LC_ALL is on the
allowed list). (2) The CI path triggers missed root inputs of the release (package.json, pnpm-lock.yaml, tsconfig.json,
.gitmodules: the clone's root install, tsx's config, the submodule list), so a lockfile-only change ran no release spec;
they are listed now (spec kept: tests/release-ci-path-triggers-adversary.spec.ts, which parses the workflow's lists).
(3) Stated limit, not fixed (the pass's unproven item, older than this diff): a caller whose own environment already
exports bash functions (BASH_FUNC_*) or a BASH_ENV file, and who sets RELEASE_ENV_SEALED=1 to skip the re-exec, runs code
before or inside the script's checks. That is code already running as the operator in the operator's shell; the
script's environment seal guards against accidental configuration variables (npm_config_*, NODE_OPTIONS, GIT_*), not
against a compromised shell, which no script it starts can defend against. Passed (the report's list): the gitlink and
driver checks with forced quoting, the status and record greps, the locale reaching the CLI and git children, a normal
release end to end under the forced C locale (59 s), and the built bytes (node's default Intl locale is en-US under C
and C.UTF-8; nothing formats dates or numbers at build time).

## F-38. Tenth adversary pass, on 2dd59b2: root build configs triggered no CI run

next build reads build configs it finds above app/ (browserslist targets through getSupportedBrowsers' upward walk,
PostCSS through findConfig/find-up; app/ has neither), so a root `.browserslistrc` or `postcss.config.mjs` changes what
the release compiles, yet neither name was in the workflow's path triggers (spec kept, which asks Next's own functions:
tests/release-ci-root-build-config-adversary.spec.ts). Rather than list names, every root file now triggers the release
specs (`"*"` and `".*"` in both lists), matching trust-config's rule that every file at the repository root is a build
input; root `.npmrc`, `pnpm-workspace.yaml` and `.gitignore` are covered by the same globs. Passed (the report's list):
the locale export before the environment check (a non-UTF-8 name refused, LC_CTYPE refused, a normal release still runs
end to end), newline-named variables, byte-level cut/grep anchoring under C, the specs' imports all covered.

## F-39. Codex code review r6 (86afb72): REVISE. F2 fixed here; F1 is a decision

Codex r6: r5 F1 and F2 RESOLVED; the othello-chains identity, settings, variable names and previews-only protection
confirmed read-only. **F2 MAJOR (fixed):** `--drop-pulled-env` checked only the pull's snapshot, and Vercel applies the
project's variables to the deployed functions at deployment time, so a NODE_OPTIONS added after the pull would have
run in the deployment. The deploy step (deployRecorded) now asks Vercel for the project's variable NAMES right before it
deploys, through the verified pinned CLI (`vercel api /v10/projects/<id>/env?teamId=<team> --raw`, run by a runner that
echoes nothing; only each record's `key` is kept), and refuses unless every name is in the reviewed vercelEnvNames (which
already refuses NODE_*, NEXT_PUBLIC_*, NPM_CONFIG_* and Vercel's own names); a failed, unreadable, paginated or
nameless answer refuses too. It asks again right after the deploy: any change, or no answer, voids the deployment like a
file changed during the upload (URL recorded as voided; remove it, or in production roll back). Stated residual: a
variable added and removed again inside the seconds between the two reads, by someone with edit access to the project,
is not seen; Vercel exposes no environment revision to pin, so that account-level access is trusted for the window.
**F1 HIGH (open):** a caller PATH that puts a program named env, bash, pnpm, node or git first runs it in the release.

## F-40. Codex r6 F1 (HIGH): the caller's PATH; the trust boundary, stated

Codex r6: a caller-chosen PATH let a program named env (at the re-run), pnpm or node stand in for the real one. The
decision (Joshua, 2026-10-01): harden what the release itself runs, and state the trust boundary rather than
authenticate the operator's own toolchain. The boundary: the operator's own account is trusted, because anything that
runs as it already holds the Vercel login in HOME and could deploy without this script; the release cannot raise that
bar, and does not claim to. Everything that is not the operator's is kept out:
- before the environment seal the script runs only builtins and absolute system paths: `#!/bin/bash -p`,
  `/usr/bin/readlink`, and the re-run `exec /usr/bin/env -i ... /bin/bash -p` (bash -p: no BASH_ENV, no functions from
  the environment);
- right after the seal, before any command is looked up on PATH, every PATH entry that is relative, empty, missing,
  owned by another user, or writable by group or others (or under a folder they can write to without the sticky bit) is
  dropped, and the count is printed (on WSL every /mnt/c folder is 0777: 32 of this machine's 52 entries are dropped,
  the Linux toolchain under ~/.nvm, ~/.foundry and /usr/bin is kept);
- every system tool the release itself uses (git, env, grep, cut, sort, mkdir, cp, rm, mktemp, chmod, dirname, readlink,
  stat, id, bash) is run by absolute path, the environment check included (a PATH `env` that printed nothing made that
  check pass on anything), so PATH only ever supplies the operator's own toolchain (node, pnpm, npm, forge).
Spec: tests/release-script-path-trust.spec.ts (programs named like every tool the script uses, planted first on PATH in
a folder others can write to, in the working folder through relative/empty entries, under a shared folder without the
sticky bit: none runs; in the operator's own folder: the absolutely-pathed ones never run). Stated: the operator's own
node, pnpm, npm and forge are trusted, as the operator's Vercel login is.

## F-41. Batched adversary pass on 86afb72..275f514: PATH by spelled name; gitIn's PATH git; F2 strengthened

Two F1 defects (specs kept: tests/release-script-path-symlink-adversary.spec.ts, tests/release-script-gitin-path-adversary.spec.ts).
(1) The PATH filter judged each entry by the name it was spelled with and kept that name, which is resolved again at
every lookup: a link to a folder under a shared folder without the sticky bit, or `/proc/self/cwd` (the working folder
by another name), passed. Each entry is now resolved once (`/usr/bin/realpath -e`), the folder it resolves to and that
folder's parents are what is checked, and the resolved path is what goes on PATH. (2) gitIn and gitProgramDrivers in
ops/trust-config.ts ran `git` from PATH; they now run /usr/bin/git. F2 held against every attack (the --record entry,
4xx JSON bodies, unreadable or multiple documents, pagination, spawn errors, value leaks, teamId override, the after
check). From the pass's suspicions, done: the variable check now reads both lists that reach the project's functions,
the project's own (`/v10/projects/<id>/env`) and the team's shared variables linked to it (`/v1/env`; the team has 0
today), refuses a project list that reports hidden production variables (`hiddenProductionEnvCount`, 0 today), and the
check after the deploy compares a fingerprint of every record (source, id, name, targets, last change time; never a
value), so an edit to a reviewed variable or a new record of one during the deploy voids it too. Also: the release now
refuses to run anywhere but Linux (it relies on GNU tools at /usr/bin; macOS has neither /usr/bin/mkdir nor stat -c).

## F-42. Adversary pass on 7afd45e (the r7 target): program links, parent owners, the hidden count; CI's tool cache

Three defects (specs kept: tests/release-script-path-program-link-adversary.spec.ts,
tests/release-script-path-parent-owner-adversary.spec.ts, tests/release-deploy-hidden-count-adversary.spec.ts). (1) The
PATH filter checked folders, never the program a lookup finds: the operator's own 755 folder holding `pnpm -> <a 0777
folder>/pnpm` was kept and the planted pnpm ran. Each program the release takes from PATH (node, npm, pnpm, forge) is
now followed link by link: every folder a hop lives in must be an own folder, and the file it ends at must belong to
the operator or root and not be writable by group or others; otherwise the release stops. (2) Parent folders were
judged by mode only: one owned by another user (755, or 1777 sticky) passed, though its owner can always swap the folder
below. One check (own_dir) now requires the folder and every folder above it to belong to the operator or root, the
folder to be unwritable by group/others, and a folder above to be writable by them only with the sticky bit. (3) A
project list without `hiddenProductionEnvCount` was taken as complete: the count must now be reported and be 0. From the
pass's suspicion: the record fingerprint also covers type, gitBranch, customEnvironmentIds, comment and configurationId.
Also: CI on 7afd45e failed only in the release-script specs, because GitHub's hosted runner keeps node and the globally
installed pnpm under /opt/hostedtoolcache, which other users can write, so the release (correctly) dropped those PATH
folders and found no pnpm (local: 24 sealed specs passing on 7afd45e). The release now names each PATH entry it drops and
why, and the CI job prints its PATH folders' owners and modes and removes group/other write from the tool cache before
the release specs run. The real toolchain here passes: node, npm and pnpm under ~/.nvm and forge under ~/.foundry.

## F-43. Adversary pass on aed6598: every program a lookup can reach; a curated PATH; shared-variable shapes

(1) Only node, npm, pnpm and forge were followed, but the release's tools look up others by name on the same PATH (pnpm
runs sh, next's shim sed and dirname, the build uname and getconf, the Vercel CLI's deploy git): a link to any of them
in a kept folder, into a folder others can write to, ran (spec kept: tests/release-script-path-child-program-link-adversary.spec.ts).
Refusing or dropping a folder for one such program does not work in practice: on this machine Docker Desktop's WSL
integration puts links into /mnt/wsl (root 1777) in /usr/local/bin and /usr/bin itself. So the release now builds a
private folder, $WORK/bin (0700), right after its temporary folder exists and before its first PATH lookup, and runs
with that folder as its whole PATH: in the order of the kept PATH folders, each entry that can run is linked there by
its name to the final file it resolves to, if every folder its link chain passes through is an own folder and the file
belongs to the operator or root and is unwritable by group/others; an entry that cannot run is passed over, as a lookup
would; one that is not the operator's own is passed over and named (the first that passes wins its name). On this
machine: 1186 programs linked in 2.5 s; 9 skipped (docker, docker-compose, hub-tool, kubectl and others linking into
/mnt/wsl); node, npm, pnpm, forge, sh, sed, git, dirname, uname and getconf all point at verified files. Because each
link points at the final file, nothing reached later can be swapped. (2) A shared variable whose projectId was not a
list of ids (a string, null, missing) was silently treated as another project's; any such shape is now a refusal
(spec kept: tests/release-deploy-shared-projectid-shape-adversary.spec.ts). Also from the CI diagnostics: GitHub's
hosted runner leaves /opt, /usr/local/bin and the tool cache 777; the CI job tightens them before the release specs.

## F-44. Adversary pass on 3429255 (the r7 target): a folder name holding a colon; the build folder's owners

(1) The PATH filter kept a folder's real path whole, but $WORK/bin's step split the joined PATH on `:` again, so an own
folder whose real name held a colon (`x:<a shared folder>`) came back as unchecked pieces whose files were linked, and a
piece beginning with `-` reached `find` as an option (`x:-delete` deleted top-level files of the checkout). Low
likelihood (only the operator or root can make such an own folder) but real (spec kept:
tests/release-script-path-colon-folder-adversary.spec.ts). A real path containing a colon is now dropped (named), and the
step refuses any piece that is not an absolute folder. (2) From the pass's suspicion: $WORK (which holds the release's
whole PATH) lived under $HOME/.cache unchecked; the build folder is now resolved and must pass own_dir all the way up,
or the release stops before building anything. (3) A shared variable whose project list is empty is refused: whether it
means no project or every project is not stated anywhere the release reads.

## F-45. Code review r7 (3429255): SHIP; the factory deployed and verified; the config commit

Codex code review r7 (reviews/arb-code-review-r7.md, sha256 59bf3a10…): VERDICT SHIP, G-D1 and G-D2 SHIP at 3429255,
no findings; deploy through DeployFactory.s.sol. On 2026-10-02 Joshua deployed it from a clean checkout of 3429255 with
his own key (othello-design/arb/deploy-factory.sh: hidden key prompt, dry run, explicit "yes"): factory
0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5, tx 0x4d5c1da89db5cda4b7f326a6ef9dc0c32ce745bff71f94ea38851770b5581acd
(block 127656060, status 1), from 0xDCA915e9F833002c978e162610E3e88eD159a1Ff at nonce 0. The live runtime equals the
build of 3429255 byte for byte (19175 bytes; its two immutables are USDG); keccak256 0xd1c2e7bd…a472f1. Source verified
on the explorer (Blockscout: OthelloFactory, v0.8.30, optimizer 200, cancun, fully verified). Config commit c959260
changes only config.ts and the receipt; the CI job trust-config is green on it.

## F-46. Adversary pass on 4d9fcdd: XDG_DATA_HOME's folder; a page marker that is not an object

(1) The release judged every PATH folder but kept XDG_DATA_HOME through the seal unjudged, and forge loads solc from
$XDG_DATA_HOME/svm; a solc planted in a folder others can write to ran at the release's forge build. Each folder that
HOME, XDG_DATA_HOME, XDG_CONFIG_HOME and NVM_DIR name (HOME always, the others when set) must now pass own_dir, or the
release stops before any tool runs (spec kept: tests/release-script-xdg-data-home-adversary.spec.ts). (2) A Vercel
pagination marker that is a string or a list is refused as unreadable instead of read as one page.

## F-47. Adversary pass on c959260 (the config commit): tests that assumed no factory; the gate aligned with r11

Eight tests assumed TRUSTED_FACTORY is null and failed once the deployed factory was committed (and three hostile-config
style specs built their input by replacing the literal `= null;` line, which then silently matched nothing). The gate's
rule "since the deployed commit only config.ts, the receipt and notes may change" forbade fixing them without a new
deploy, which contradicts ARB-DESIGN r11 §8 ("A change to the page bundle needs a new G-D2 only"). Joshua chose to keep
the factory and align the gate: rule 2 now freezes only CONTRACT_BUNDLE (evm/src, evm/script, evm/test, evm/lib, core/,
evm/foundry.toml, evm/foundry.lock, evm/remappings.txt, .gitmodules) since the deployed commit; everything else is the
page bundle, judged by the G-D2 review (the gate included: a deliberate change to it is the review's to catch, as its
header's Limit says). Tests now hold for a null and a set factory; the smuggled-factory tests give the smuggled factory
its own address and check whose code is read (mutation: an adapter that takes the passed factory fails them);
tests/config-fixture.ts replaces the TRUSTED_FACTORY declaration whatever its value and throws when it is missing.

## F-48. Adversary passes on b9e3509, 9a1fa97 and c1fc27e: what git lists as changed

(1) `git diff --name-only` C-quotes a name holding a tab, a quote, a backslash or a non-ASCII byte, so
`"evm/src/Fa\303\247ade.sol"` matched no bundle prefix; names are now read with -z. (2) diff.ignoreSubmodules=all or
submodule.<name>.ignore=all in the repository's config hid an evm/lib gitlink bump; the diff passes
--ignore-submodules=none. (3) The receipt holds the commit abbreviated ("3429255"); a branch or tag of that name won over
the commit and made the diff empty; the abbreviation is resolved among commit objects only (rev-parse --disambiguate,
exactly one), and only the full hash is used. Specs kept: tests/trust-config-quoted-path-adversary.spec.ts,
tests/trust-config-ignored-gitlink-adversary.spec.ts, tests/trust-config-ref-named-commit-adversary.spec.ts.

## F-49. Adversary pass on 3803cdd: the receipt's commit field could be moved past a bundle change

Rule 2 measured the freeze from the receipt's own "commit" field, which is outside the bundle; a later commit could
rewrite it to point past a core/ (or evm/test, evm/script, Foundry config) change, which rules 1, 3, 4 and 5 do not see.
The gate now pins DEPLOYED_COMMIT = 3429255c44fb3d20a194ca1186b7af6b7a17b962 like its other pinned inputs: the receipt
must name it and rule 2 diffs from it. A new deploy needs a new G-D1 and changes the pin in a reviewed commit. Spec kept:
tests/trust-config-moved-receipt-commit-adversary.spec.ts; refusal cases in tests/trust-config.spec.ts.

## F-50. Adversary pass on 84043b3: a file named HEAD; a forged commit-graph

(1) A committed file named HEAD made `git diff <deployed> HEAD` stop with "ambiguous argument", so the gate failed for
the real, correct state (blocking releases, never passing a bad factory); the revisions now end with "--". (2) A
rewritten .git/objects/info/commit-graph could give the deployed commit HEAD's tree and hide a core/ change (needs write
access to .git, like replace refs); sealedGit pins core.commitGraph=false. Specs kept:
tests/trust-config-head-named-file-adversary.spec.ts, tests/trust-config-forged-commit-graph-adversary.spec.ts.

## F-51. Adversary pass on 55a2452: a forged tree object; a long list of names

(1) git checks a commit object's hash when it reads it, not the trees and files under it; a loose object rewritten in
.git could give the deployed commit's core/ HEAD's tree and empty rule 2's diff (hand runs only: CI checks out fresh,
and the release's `git clone --no-local` refused the forged repository). changedSince now runs `git fsck
--no-dangling` first (about 0.5 s), which re-hashes every object and fails on any mismatch, so a forged object store
fails closed. (2) gitIn kept Node's 1 MiB output limit; 1.1 MB of page-bundle names made rule 2 fail a correct state.
The limit is now 256 MiB. Specs kept: tests/trust-config-forged-tree-object-adversary.spec.ts,
tests/trust-config-long-names-adversary.spec.ts. Stated limit (all of F-47 to F-51): the gate is in the page bundle
and trusts the machine it runs on; a deliberate change to it, or an attacker who controls the runner, is the G-D2
review's and the account boundary's (F-40) to catch, not the gate's.

## F-52. Adversary pass on dec7f58: fsck read every worktree's index

With no objects named, `git fsck` also reads the index of every worktree of the repository; a sibling worktree on a new
orphan branch (its index names the empty tree, which git never writes) made it exit 2, so the gate failed for a correct
developer checkout. fsck now starts from the deployed commit and HEAD only (`--no-reflogs <deployed> HEAD`) and still
re-hashes every object it reads (the forged-tree spec still fails closed). Spec kept:
tests/trust-config-orphan-worktree-fsck-adversary.spec.ts.
