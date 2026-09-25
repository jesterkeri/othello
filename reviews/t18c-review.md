VERDICT: changes required

Review target: `155ee2f` (`9ef92da..155ee2f`). `HEAD` was
`155ee2f28182343ff2f846dff32545fe77d604ad`.

## r1 findings

1. **How It Works — not fully fixed.** The r1 L7 and L10 defects are fixed:
   `HowItWorks.tsx:52-56` now names issuer powers and permissionless
   transitions; `:78-80` makes the return conditional on no post-payout
   default; and `:102-107` correctly describes the SPEC §6 sale, guarantee,
   pause, pool-insufficient, and pre-payout cases. However, a new broad claim
   remains at `:48-49`; see the MAJOR finding below.
2. **`/api/quote` — not fully fixed.** It now rejects missing, non-numeric,
   negative, and empty-array values; `tests/app-quote.spec.ts` verifies those
   cases and canonical micro-USDC reporting. But whitespace-only input still
   passes as a zero impact and a labelled route; see the MINOR finding below.

## Findings

**MAJOR — INSIDE — `app/src/components/howitworks/HowItWorks.tsx:48-49`:**
“members don't have to trust each other to keep paying” contradicts the
protocol's stated liveness limit. KNOWN-LIMITS L3 and SPEC §5/
`declare_default` explicitly exclude pre-payout default: a seat that has not
received may stop contributing, cannot be defaulted, and prevents the current
pot from being released. The same component acknowledges this at `:106-107`,
so the page gives both the false general assurance and its exception. For
example, seat 3 can stop paying in round 1; the other seats must wait for that
wallet to pay late, despite having no on-chain remedy. State that the protocol
does not need a trusted coordinator, rather than saying members need not trust
each other to pay, or qualify the claim with the pre-payout liveness limit.

**MINOR — INSIDE — `app/src/app/api/quote/route.ts:40-43`:** a whitespace-only
impact and route label satisfy the new structural checks. JavaScript converts
`Number(" ")` to `0`, and the length check accepts `" "`; consequently a
successful upstream body such as
`{outAmount:"1", priceImpactPct:" ", routePlan:[{swapInfo:{label:" "}}]}`
returns 200, reports a zero impact that Jupiter did not provide, and renders a
visually blank route. This is still an incomplete quote represented as a fact.
Require a non-blank numeric representation for string impact values and a
trimmed non-empty label (and return the trimmed label); add the two adversary
cases to `tests/app-quote.spec.ts`.

## U7

- Findings: **INSIDE 2, OUTSIDE 0**. This is indicative, not a rigorous
  cold-read measurement: the prompt supplied its requirements and r1 findings
  in the same turn (protocol U1).

## U8 — not checked

- I did not run an ops script, send a transaction, make an RPC/API read, or
  open a keypair, `.env*` content, `~/.config/solana`, or
  `~/.config/othello-demo`. A presence-only check confirmed root `.env`, root
  `.env.local`, and `app/.env.local` are absent.
- I did not run `anchor build`: its program-ID validation automatically reads
  the local deploy keypair, prohibited by this review. This range changes no
  Rust program source.
- I did not reproduce browser/wallet signing, Vercel deployment, or live
  Jupiter/GeckoTerminal behaviour. The quote route tests stub `fetch`; no
  request leaves the machine.
- The original `reviews/t18c-brief.md` is absent from the target following the
  merge. I used its version at the supplied range base and the r1 review for
  the original-scope checks.

## Verification (serial)

```text
git rev-parse HEAD
155ee2f28182343ff2f846dff32545fe77d604ad

git diff --stat 9ef92da..155ee2f
8 files changed, 309 insertions(+), 186 deletions(-)

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (contents not read).

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
37 files, one process per file: 215 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check 9ef92da..155ee2f
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output
```
