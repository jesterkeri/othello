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
