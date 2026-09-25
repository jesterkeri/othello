VERDICT: changes required

Review target: `d0afc33` (`ec574c3..d0afc33`). The worktree remained on
`task/T18d-shell`; `HEAD` was the brief-only follow-up `0c953d1` (the diff
from target to HEAD adds only `reviews/t18d-brief.md`).

## Findings

**MAJOR — INSIDE — `app/src/components/live/LiveCircle.tsx:169-226` and
`app/src/lib/live.ts:165-171`:** the action controls claim to enable only
when the program's conditions hold, but only implement a subset of them.
`Release pot` is enabled whenever every seat is paid, even if the same decoded
view says the price is stale, the multiplier/feed is Repricing, or
`nextGateShortBy > 0` (Paused); the program then refuses with `PriceStale`,
`MultiplierPriceMismatch`, or `ReserveOvercommitted`. `Update coverage` is
enabled while stale or Repricing even though `value_position` makes it refuse
for those conditions. `Declare default` checks time and seat bits but not a
stale wrapper price, and `LiveCircle` never reads the pool USDC vault, so it
cannot withhold the button when its known `pool_insufficient` precondition is
false.

For example, after a price fall sets `nextGateShortBy > 0`, every member can
pay; this page enables and says “anyone can release the pot,” while the
program necessarily rejects the signed transaction as `ReserveOvercommitted`.
This directly violates brief §1's button rule and reintroduces the false
automatic-release implication at `LiveCircle.tsx:195-196`. Derive the button
guards from the live `stale`, `repricing`, and paused state; fetch the pool
vault/required recovery for the default control (or state its availability is
unknown rather than enabling it); and add component-level enabled/disabled
tests for every refusal state.

## U7

- Findings: **INSIDE 1, OUTSIDE 0**. This is indicative, not a rigorous
  cold-read measurement: the brief supplied scope and requirements in the
  same turn (protocol U1).

## U8 — not checked

- I did not run an ops script, send a transaction, make an RPC/API read, or
  open a keypair, `.env*` content, `~/.config/solana`, or
  `~/.config/othello-demo`. A presence-only check confirmed root `.env`, root
  `.env.local`, and `app/.env.local` are absent.
- I did not run `anchor build`: Anchor's program-ID validation reads the local
  deploy keypair, prohibited by this review. The action test itself builds the
  devnet feature inside bankrun and passed.
- I did not reproduce browser clicks, wallet signing, headless phone-layout
  checks, Vercel deployment, or live devnet/mainnet/Jupiter/GeckoTerminal
  behaviour. In particular, the new tests cover instruction construction and
  execution but not the button guards, which is the finding above.

## Verification (serial)

```text
git branch --show-current; git rev-parse --short HEAD
task/T18d-shell
0c953d1

git diff --stat d0afc33 0c953d1
reviews/t18d-brief.md | 90 +++++++++++++++++++++++++++++++++++++++++++++++++++
1 file changed, 90 insertions(+)

git diff --stat ec574c3..d0afc33
22 files changed, 769 insertions(+), 231 deletions(-)

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (contents not read).

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date, already up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date, already up to date.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
40 files, one process per file: 236 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check ec574c3..d0afc33
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output

./scripts/check-reviews.sh
FAIL reviews/t18d-review.md says changes required. Fix and re-review, or record
a deliberate override in KNOWN-LIMITS.md and remove the file from this gate.
```
