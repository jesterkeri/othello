VERDICT: implementation-ready

Review target: `f95c4b4` (`c3f09ef..f95c4b4`). `HEAD` was
`f95c4b4e5d5434bf4ba911184c932935d6ad1673`.

## r3 findings

1. **MAJOR, INSIDE — fixed.** `exactTokens` now lives in the pure
   `app/src/lib/format.ts`, with no app alias or browser API dependency.
   `tests/app-mint-info.spec.ts:14` imports that module directly, so the root
   TypeScript project no longer imports the client hook. `pnpm exec tsc
   --noEmit -p tsconfig.json` passes.

2. **MINOR, INSIDE — fixed.** `AssetDetail` now imports `exactTokens` from
   `@/lib/format`, leaving the `useLiveXStocks` adversary-test stub responsible
   only for the exports it actually consumes. The rendered revoked-authority
   adversary test runs its assertion and passes.

No new findings in the r4 range. The move preserves exact u64 formatting,
including the u64 maximum, sub-token, and zero-decimal cases covered by the
existing test.

## U7

- Current findings: **INSIDE 0, OUTSIDE 0**. This is indicative rather than a
  rigorous cold-read measure because the single prompt supplied prior findings
  and the intended fixes (protocol U1).

## U8 — not checked

- I did not run any ops script, make an RPC read, send a transaction, or open
  a keypair, `.env*` content, `~/.config/solana`, or
  `~/.config/othello-demo`.
- I did not run `anchor build`, because it automatically reads the local
  deploy keypair to compare its public id, contrary to the review's explicit
  no-keypair rule. No Rust source changed in this range.
- I did not reproduce browser-wallet signing, browser screenshots, Vercel
  deployment, or a production dependency audit.

## Verification (serial)

```text
git status --short --branch && git rev-parse HEAD
## task/T18-live-circle...origin/task/T18-live-circle
f95c4b4e5d5434bf4ba911184c932935d6ad1673

git diff --stat c3f09ef..f95c4b4
6 files changed, 111 insertions(+), 121 deletions(-)

test ! -e app/.env.local
exit 0 (file absent; contents not read).

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

npx mocha --import=tsx --timeout 120000 tests/t18-assets-adversary.spec.ts
1 passing.

npx mocha --import=tsx --timeout 120000 tests/app-mint-info.spec.ts
6 passing.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
33 files, one process per file: 195 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 89 pages.

git diff --check c3f09ef..f95c4b4
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
