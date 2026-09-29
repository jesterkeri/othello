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
