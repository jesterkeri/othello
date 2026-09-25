VERDICT: changes required

Review target: `e5663a9` (`155ee2f..e5663a9`). `HEAD` was
`e5663a93dc23d7b2e7f8f6baf762210101ab2ae2`.

## r2 findings

1. **How It Works — not fully fixed.** `HowItWorks.tsx:54-57` correctly adds
   the L3 pre-payout stall, L7 issuer powers, and L10 no-keeper limit, and no
   longer says members need not trust one another to pay. But the revised hero
   still says stock itself covers all remaining debt; see the first MINOR
   finding.
2. **`/api/quote` — not fully fixed.** The new decimal parser rejects blank,
   empty, and non-finite impacts; `trim()` rejects ordinary whitespace labels;
   and the four new regression cases pass. A zero-width format character is
   neither removed by `trim()` nor visible in the UI; see the second MINOR
   finding.

## Findings

**MINOR — INSIDE — `app/src/components/howitworks/HowItWorks.tsx:49-50`:**
the hero says the post-payout member's locked stock “covers what they still
owe,” but stock is collateral, not an unconditional cover. SPEC §6 explicitly
allows `shortfall` after the sale, then uses the guarantee/reserve and may
leave an `escrow_deficit`; KNOWN-LIMITS L8 says an unfunded pool instead
reverts the default. In the documented demo default, 1.1 locked tokens sell
for 132 USDC against 200 USDC owed, leaving a 68-USDC shortfall. Step 4
correctly describes that case, so the hero now contradicts its own fuller
explanation. Say the locked stock *helps cover* or *secures* what remains
owed, with the following step explaining what happens if it is insufficient.

**MINOR — INSIDE — `app/src/app/api/quote/route.ts:47-50`:** `trim()` is not a
visible-text test. A route label containing only U+200B ZERO WIDTH SPACE (or
U+2060 WORD JOINER) survives `trim()` with length 1, passes the label check,
and renders blank; a quote with that route gets HTTP 200 despite the stated
requirement that every step be labelled with visible text. The new tests cover
ordinary spaces but not this case. Require at least one visible Unicode code
point (for example, reject Unicode separators and controls/format characters
as the sole label) and add a U+200B regression case.

## U7

- Findings: **INSIDE 2, OUTSIDE 0**. This is indicative, not a rigorous
  cold-read measurement: the prompt supplied requirements and prior findings
  in the same turn (protocol U1).

## U8 — not checked

- I did not run an ops script, send a transaction, make an RPC/API read, or
  open a keypair, `.env*` content, `~/.config/solana`, or
  `~/.config/othello-demo`. A presence-only check confirmed root `.env`, root
  `.env.local`, and `app/.env.local` are absent.
- `anchor build` was intentionally skipped as permitted: Anchor's program-ID
  validation reads the local deploy keypair. No Rust source changes are in
  this range.
- I did not reproduce browser/wallet signing, Vercel deployment, or live
  Jupiter/GeckoTerminal behaviour. Quote tests stub `fetch`, so no request
  leaves the machine.
- `reviews/t18c-brief.md` is absent at this target; I used the supplied scope,
  prior review, protocol, SPEC §5/§6, and KNOWN-LIMITS for the original-scope
  checks.

## Verification (serial)

```text
git rev-parse HEAD
e5663a93dc23d7b2e7f8f6baf762210101ab2ae2

git diff --stat 155ee2f..e5663a9
5 files changed, 98 insertions(+), 72 deletions(-)

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (contents not read).

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
37 unique files, one process per file across serial batches: 219 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check 155ee2f..e5663a9
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
