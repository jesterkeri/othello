VERDICT: changes required

Review target: `c3f09ef` (`0aac57c..c3f09ef`). `HEAD` was
`c3f09efe58706fcd1cdcb9308ab6801d6bc4272f`.

## Earlier findings

- **r1 findings — remain fixed.** None of the r1 remediation paths changed in
  this range. The pre-send existing-circle/member, pool/discount, and feed
  checks remain in `ops/demo.ts:149-170`; the command remains load-only after
  a demo record in `ops/seed-demo-circle.ts:27-31`; and the prior diff
  whitespace issue remains absent.
- **r2 MINOR — fixed.** `app/src/components/assets/AssetDetail.tsx:89-94` now
  renders the raw supply through `exactTokens`, whose `BigInt` and string
  arithmetic preserve all u64 digits (`useLiveXStocks.ts:69-74`). The former
  rounded wallet-style display is now explicitly prefixed “about.”
  `tests/app-mint-info.spec.ts:57-65` covers the NFLXx fixture, u64 maximum,
  sub-token, and zero-decimal cases.

## New findings

**MAJOR — INSIDE — `tests/app-mint-info.spec.ts:14`:** the new test imports
`exactTokens` from `app/src/components/assets/useLiveXStocks.ts`, a browser /
Next client hook. The root TypeScript project does not resolve the app `@/`
alias or DOM `window` types, so the required `pnpm exec tsc --noEmit -p
tsconfig.json` now fails with four errors in that imported client module. Thus
the project’s root type-check/CI gate is red even though the app-only typecheck
passes. Move `exactTokens` to a DOM-independent shared utility (or test a
non-client module) so the root test project does not import a client hook.

**MINOR — INSIDE — `tests/t18-assets-adversary.spec.ts:61-66`:** the new
server-render adversary-test stub re-exports `mult`, `tokens`, and `when` from
`./useLiveXStocks`, but not the newly imported `exactTokens`. Loading
`AssetDetail` therefore throws `SyntaxError: ... does not provide an export
named 'exactTokens'` before either revoked-authority assertion runs. A revoked
ScaledUiAmount authority could regress without this claimed adversary test
testing it. Re-export `exactTokens` in the stub (or remove the stub's need to
imitate that module) and keep the real rendered-row assertion.

## Scope checks

- `mintInfo.ts:117-118` reads the optional ScaledUiAmount authority from the
  extension bytes. `AssetDetail.tsx:187-199` shows its holder, “Nobody:
  authority revoked,” or “Not enabled,” so the actual page no longer asserts
  an updater exists merely because the extension exists.
- The three polling consumers use a monotonically increasing request id and
  only let the current request set data/error. This eliminates an older
  completed response overwriting a newer result.
- `app/.env.local` is absent, the app typecheck and production build pass, and
  the Next build reported no loaded environment file.

## U7

- Current findings: **INSIDE 2, OUTSIDE 0**.
- This is an indicative, not rigorous, cold-read measure: the single prompt
  supplied the change list and prior findings (protocol U1).

## U8 — not checked

- I did not run ops scripts, make RPC reads, send any live transaction, or
  inspect a keypair, `.env*` content, `~/.config/solana`, or
  `~/.config/othello-demo`.
- I did not run `anchor build`: it automatically reads the local deploy
  keypair to compare its public id, which conflicts with this review's
  explicit no-keypair rule. No Rust source changed in this range.
- I did not reproduce wallet signing, browser screenshots, Vercel deployment,
  or a production dependency audit.

## Verification (serial)

```text
git status --short --branch && git rev-parse HEAD
## task/T18-live-circle...origin/task/T18-live-circle
c3f09efe58706fcd1cdcb9308ab6801d6bc4272f

git diff --stat 0aac57c..c3f09ef
11 files changed, 361 insertions(+), 86 deletions(-)

test ! -e app/.env.local
exit 0 (file absent; contents not read).

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

npx mocha --import=tsx --timeout 120000 tests/t18-assets-adversary.spec.ts
0 passing, 1 failing: the test's useLiveXStocks stub does not export exactTokens.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
33 files run one process per file: 194 passing, 1 failing (the test above).

pnpm exec tsc --noEmit -p tsconfig.json
exit 2: tests/app-mint-info.spec.ts imports a client module; root TS cannot
resolve @/app/api/live/route, RequestInit.cache, or window.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit)
exit 0.

(cd app && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 89 pages.

git diff --check 0aac57c..c3f09ef
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
