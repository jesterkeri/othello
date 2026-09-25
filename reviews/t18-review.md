VERDICT: changes required

Review target: `0aac57c` (`2fca395..0aac57c`). I reviewed the r1 remediation at
`e5e84fb` and the new work at `0aac57c`; `HEAD` was `0aac57caf1001b24763b61cbf972dbcf1958cc73`.

## r1 findings

1. **MAJOR, INSIDE — fixed.** `ops/demo.ts:149-170` now reads any existing
   circle, pool, and feed before any funding/send and rejects a different
   ordered member list, a non-demo pool authority/discount, or another feed
   authority. `ops/seed-demo-circle.ts:27-31` also switches to the load-only
   recorded member set once `ops/demo-circle.json` exists, rather than making
   fresh keys. `tests/t24-seed-demo.spec.ts:203-210` proves different later
   seats are refused with zero sends.

   The additional statement in `DONE.md:2681-2686` is correct: the circle PDA
   includes member 1/creator (`ops/demo.ts:96-101`), so the old command with a
   different member 1 addressed a different, absent PDA and would have created
   a second circle. The recorded-member branch prevents that operational path;
   a missing recorded key now fails load-only before a send.

2. **MINOR, INSIDE — fixed.** The same pre-send block checks that an existing
   pool is owned by the demo admin and has `discountBps === 2000` and that an
   existing feed has that admin (`ops/demo.ts:160-170`).
   `tests/t24-seed-demo.spec.ts:212-218` covers a 1,500-bps pool and asserts
   zero sends.

3. **MINOR, INSIDE — fixed.** `git diff --check 2fca395..0aac57c` is clean;
   the trailing blank line in `tests/app-live.spec.ts` is gone.

## New finding

**MINOR — INSIDE — `app/src/components/assets/AssetDetail.tsx:89-90`:** the
row labelled **“Supply, raw”** calls `tokens()`. That helper converts the
mint's raw u64 to decimal token units and rounds it to at most two decimal
places (`app/src/components/assets/useLiveXStocks.ts:54-57`). It therefore
does not show the bytes’ raw supply. For example, any mint with `decimals = 8`
and raw supply `123456789` is displayed as `1.23`, despite the row promising
`123456789`; large u64 values also lose precision in `Number(BigInt(raw))`.
This conflicts with the asset-page requirement to show exactly what the mint
says about itself, without a made-up or lossy number. Render `m.supply`
verbatim for the raw row (and retain a clearly labelled formatted display if
wanted), with a UI regression test.

## Other scope checks

- `/assets` and `/assets/[symbol]` consume only the four address-allowlisted
  mints. `dynamicParams = false` and the explicit allowlist check in
  `app/src/app/assets/[symbol]/page.tsx:7-20` make other symbols 404. The
  route verifies Token-2022 ownership, decodes the account bytes, requires
  Scaled UI, clears stale data after an error, and emits only its own error
  text. The issuer-power rows are driven by the decoded extension fields in
  `app/src/lib/mintInfo.ts`; `tests/app-mint-info.spec.ts` passed for all four
  committed real-mint fixtures. `KNOWN-LIMITS.md:13` accurately records L7.
- The Split lab records the NFLXx fixture’s multiplier data and marks the
  prices illustrative. Its `1.10 × 150 = 165`, post-split `1.10 × 10 × 15 =
  165`, naive `1.10 × 15 = 16.50`, and 20% haircut `132` agree with
  `SPEC.md:137`.
- The shared shell retains the real navigation mapping and `WalletControl`.
  The xStocks, circle, landing, and Split-lab cross-links resolve through the
  project navigation/links in source. `framer-motion` is pinned to `13.4.3`.

## U7

- Current findings: **INSIDE 1, OUTSIDE 0**.
- r1 findings verified fixed: **INSIDE 3, OUTSIDE 0**.

## U8 — not checked

- No ops script was run, no devnet/mainnet transaction was sent, and no RPC
  read was made. I did not open or inspect a wallet keypair, `.env*`,
  `~/.config/solana`, or `~/.config/othello-demo`.
- I did not run the requested app production build. Next production builds
  automatically load `app/.env.local` in this repository, which the review
  scope expressly forbids accessing. App TypeScript compilation did run.
- The prescribed `anchor build` automatically compared the project deploy
  keypair's public program id with `declare_id!` and reported their existing
  mismatch; I did not open, print, or inspect key material. That automatic
  tool access means the command cannot be treated as a credential-free
  verification step.
- I did not reproduce browser rendering, wallet signing, Vercel deployment,
  or the claimed production-audit count. `pnpm audit --prod` could not reach
  npm's advisory endpoint (EAI_AGAIN), so “10” was not independently
  verified.

## Verification (serial)

```text
git status --short --branch && git rev-parse HEAD
## task/T18-live-circle...origin/task/T18-live-circle
0aac57caf1001b24763b61cbf972dbcf1958cc73

git diff --stat 2fca395..e5e84fb
6 files changed, 174 insertions(+), 4 deletions(-)

git diff --stat e5e84fb..0aac57c
22 files changed, 1199 insertions(+), 14 deletions(-)

git diff --check 2fca395..0aac57c
exit 0

./scripts/check-secrets.sh
no credential-shaped strings in client output

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

anchor build
Reported the pre-existing Program ID mismatch between the local deploy-keypair
public id and `declare_id!`; compilation nevertheless finished successfully:
`Finished release profile` and `Finished test profile`.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
32 files, one process per file: 194 passing, 0 failing.

cargo test -p othello
57 passed, 0 failed; 0 doc-tests.

cargo test -p othello --features devnet
56 passed, 0 failed; 0 doc-tests.

cargo clippy --all-targets -- -D warnings
exit 0.

cargo fmt --check
exit 0.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit)
exit 0.

(cd app && corepack pnpm@10.32.1 audit --prod)
Could not complete: npm advisory POST failed with EAI_AGAIN before the tool
timeout; audit count not verified.
```
