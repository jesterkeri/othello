VERDICT: changes required

Review target: `0f0b2b6` (`d0afc33..0f0b2b6`). The worktree remained on
`task/T18e-circle-design`; `HEAD` was the brief-only follow-up `ef79981`.
`git diff --stat 0f0b2b6 ef79981` reports only `reviews/t18e-brief.md`.

## r1 finding

**Not fully fixed — MAJOR — OUTSIDE — `app/src/components/live/LiveCircle.tsx:202-226,252`:** the r1 repair correctly adds fresh-price, repricing, pool-liquidity, and strict-grace guards, and `app/src/lib/circle.ts:304-311` reproduces `declare_default.rs:137-176`'s `recovered` rounding. Its paused guard, however, treats the stored `next_gate_short_by` as a current `release_pot` precondition:

```ts
const canRelease = active && owing.length === 0 && !priceBlock && !dv.paused && !!recipient;
```

That conflicts with SPEC.md:129. `next_gate_short_by` is the result of the last `update_coverage`, `release_pot`, `declare_default`, or `top_up_reserve`; `add_stock` and price changes deliberately do not refresh it. The specification therefore says the UI must show Paused but never disable Release pot on that field. `release_pot.rs:219-265` recomputes the actual gate from the current members and price; it does not reject merely because the stored field is non-zero.

Concrete failure: a price fall sets `next_gate_short_by > 0`; then a member adds enough stock, or a fresh recovered price makes the current gate pass. `add_stock` intentionally leaves Paused unchanged (covered by `tests/t16-top-up.spec.ts`'s “leaves Paused alone” case). The program would release the fully funded pot after recomputing its gate, but this screen disables the only Release control until someone first sends an unnecessary coverage update. Restore the SPEC behaviour: keep Release enabled when its directly knowable prerequisites hold, state that Paused is from the last check, and let the program return its typed current-gate refusal if it still fails. Replace the paused-disabled expectation in `tests/app-live-guards.spec.ts` with the stale-state recovery case.

This is OUTSIDE rather than a confirmation of the prompt: the brief explicitly required the opposite paused behaviour, while the controlling SPEC and the instruction's actual gate say it is wrong.

## New findings

**MAJOR — INSIDE — `app/src/components/portfolio/Portfolio.tsx:213-215`:** the new holdings row converts the on-chain `u64` raw balance to a JavaScript `Number` before rendering it, then labels the scaled decimal as `raw`. The token-account amount is a full `u64` and has no JavaScript-safe upper bound. For example, raw `9007199254740993` is rounded to `9007199254740992` before division; both the shown amount and the subsequent multiplier/value presentation can be wrong. Even at ordinary size, a balance of one 8-decimal token is rendered as `1.000000 raw`, though SPEC.md:33 defines raw as base units, i.e. `100000000 raw`.

This is a made-up mainnet holdings figure on the redesigned Portfolio page, contrary to the brief's “chain or clear error” requirement. Keep raw values as `bigint`/decimal strings and use the existing exact-token formatter (or label the displayed pre-multiplier amount accurately); add a boundary test above `Number.MAX_SAFE_INTEGER` and a units assertion.

**MINOR — INSIDE — `app/src/components/portfolio/Portfolio.tsx:185`:** the redesigned non-member circle card says “move it on: anyone can release a pot.” Anyone may sign `release_pot`, but it is only releasable after every seat has paid or defaulted, with sufficient escrow, a fresh matching price, and a passing gate (SPEC.md:109 and `release_pot.rs:117-265`). A visitor viewing a circle with an unpaid seat, stale feed, or failed gate is told an action is presently available when the program refuses it. Say “anyone may release it once its gate permits,” or direct the visitor to the live circle’s condition-specific action panel. Add this state to the screen-copy test.

## U7

- Findings: **INSIDE 2, OUTSIDE 1**. Indicative only, not a rigorous cold-read measurement: the prompt supplied scope and expected guard behaviour in the same turn (protocol U1).

## U8 — not checked

- I did not run an ops script, send a transaction, make live RPC/API reads, or read any keypair, `.env*` content, `~/.config/solana`, or `~/.config/othello-demo`. A presence-only check confirmed root `.env`, root `.env.local`, and `app/.env.local` are absent.
- I did not run `anchor build`, as instructed; it can read the local deploy keypair. The existing target artifact was used by the serial bankrun specs.
- I did not reproduce browser wallet signing, physical-device layout, deployment, or live devnet/mainnet/Jupiter behaviour. I also did not run an unscoped review outside this target and its immediate protocol consumers.

## Verification (serial)

```text
git branch --show-current; git rev-parse --short HEAD
task/T18e-circle-design
ef79981

git diff --stat 0f0b2b6 ef79981
reviews/t18e-brief.md | 84 +++++++++++++++++++++++++++++++++++++++++++++++++++
1 file changed, 84 insertions(+)

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
42 files, one process per file: 248 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check d0afc33..0f0b2b6
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (contents not read).
```
