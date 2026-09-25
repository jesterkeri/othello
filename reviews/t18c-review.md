VERDICT: changes required

Review target: `b0efb44` (`e5663a9..b0efb44`). The required worktree check
passed: branch `task/T18c-charts`, `HEAD` `5bcdea7`. The final merge adds only
`reviews/t18c-brief.md` to this target (`git diff --stat b0efb44 5bcdea7`).

## r3 findings

1. **How It Works — fixed.** `HowItWorks.tsx:49-52` now correctly describes
   the successful waterfall: stock is sold, a shortfall uses the guarantee and
   shared reserve, and an unfilled shortfall pauses the next payout pending a
   top-up. `:56-59` continues to state L3, L7, and L10, while `:105-110`
   correctly retains the pool-insufficient and pre-payout cases. This agrees
   with SPEC §5/§6 and KNOWN-LIMITS.
2. **`/api/quote` zero-width format labels — fixed.**
   `route.ts:49-52` strips Cf, Z, and whitespace before checking for a
   remaining character; `tests/app-quote.spec.ts` now rejects a label made of
   U+200B/U+200D/U+FEFF.

## Findings

**MINOR — INSIDE — `app/src/app/api/quote/route.ts:49-52`:** the revised
predicate still does not establish a visible route label. Control characters
are neither Cf nor Z nor JavaScript `\s`: `"\u0000".replace(/[\p{Cf}\p{Z}\s]/gu,
"").length` is 1. Thus an otherwise valid Jupiter body whose sole route label
is U+0000 returns 200 and renders no usable route label. This is the same
“incomplete quote shown as fact” failure on a distinct class of invisible
input. Require at least one code point from a visible class (for example
`\p{L}`, `\p{N}`, `\p{P}`, or `\p{S}`), and add a control-only-label test.

## U7

- Findings: **INSIDE 1, OUTSIDE 0**. This is indicative, not a rigorous
  cold-read measurement: scope and prior findings appeared in the same turn
  (protocol U1).

## U8 — not checked

- I did not run an ops script, send a transaction, make an RPC/API read, or
  open a keypair, `.env*` content, `~/.config/solana`, or
  `~/.config/othello-demo`. A presence-only check confirmed root `.env`, root
  `.env.local`, and `app/.env.local` are absent.
- I did not run `anchor build`; it is not in this r4 command set and reads the
  local deploy keypair during program-ID validation. No Rust source changes
  are in this range.
- I did not reproduce browser/wallet signing, Vercel deployment, or live
  Jupiter/GeckoTerminal behaviour. Quote tests replace `fetch`, so no request
  leaves the machine.
- The initial all-spec serial sweep hit the repository's intermittent Solana
  program-test panic/stall during `t10-contribute-release`; I stopped it and
  reran that file and every remaining file in fresh one-file processes.

## Verification (serial)

```text
git branch --show-current; git rev-parse --short HEAD
task/T18c-charts
5bcdea7

git diff --stat b0efb44 5bcdea7
reviews/t18c-brief.md | 100 ++++++++++++++++++++++++++++++++++++++++++++++++++
1 file changed, 100 insertions(+)

git diff --stat e5663a9..b0efb44
5 files changed, 71 insertions(+), 53 deletions(-)

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (contents not read).

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
Initial serial run stalled after a Solana program-test panic in
tests/t10-contribute-release.spec.ts; it was interrupted. That file and all
remaining files were rerun in fresh, serial one-file processes:
37 unique files, 220 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

node -e 'const re=/[\p{Cf}\p{Z}\s]/gu; console.log("\u0000".replace(re, "").length)'
1

git diff --check e5663a9..b0efb44
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
