VERDICT: changes required

Review target: `1efc57e` (`0f0b2b6..1efc57e`). The worktree remained on
`task/T18f-assets-design`; `HEAD` is the brief-only follow-up `adfe4d2`.
`git diff --stat 1efc57e adfe4d2` reports only `reviews/t18f-brief.md`.

## Round-2 findings

1. **Fixed — MAJOR — OUTSIDE — `app/src/components/live/LiveCircle.tsx:207-235`:** `canRelease` no longer includes the stored Paused bit, and the screen now calls that bit the result of the last check while leaving Release available for the program's fresh recomputation. `tests/app-live-guards.spec.ts` covers that UI condition, and `tests/t18e-paused-release-adversary.spec.ts` proves the program accepts release after recovery without another `update_coverage`.

2. **Not fully fixed — MAJOR — INSIDE — `app/src/lib/format.ts:22-24`, consumed by `app/src/components/portfolio/Portfolio.tsx:216-220`:** the raw-u64 and units repair is present, but `shownTokens` again uses `Math.round(multiplier * 1e9)`. The program's `decode_multiplier_fixed` and the app's own `toFixed1e9` use the binary-f64 floor, not a rounded value. The code even documents this exact former defect in `app/src/lib/scaledUi.ts:76-111`: AAPLx's live `1.0026642075893797` must become `1002664207`, whereas this formatter makes `1002664208`.

   Concrete failure: for `raw = "10000000000"`, `decimals = 8`, and that multiplier, Portfolio says `100.26642080`; the program's fixed-point arithmetic says `100.26642070`. This is a displayed on-chain balance, not an approximation label. Derive the formatter's fixed multiplier with the same floor implementation as `toFixed1e9` (without reintroducing browser dependencies), and test this real fractional multiplier plus a raw value that exposes the final fixed-point digit.

3. **Fixed — MINOR — INSIDE — `app/src/components/portfolio/Portfolio.tsx:185-190`:** the non-member card now says that anyone can release only once every seat has paid and the program's checks pass, rather than promising an unconditional release.

## New findings

**MINOR — INSIDE — `app/src/components/assets/BuyPanel.tsx:45-70`:** the quote route deliberately preserves Jupiter's `outAmount` as a decimal integer string, but the client immediately converts that arbitrary integer to `Number` and labels the rounded result “Raw”. A valid Jupiter response above `Number.MAX_SAFE_INTEGER` therefore changes the claimed before-multiplier amount; even below that boundary the displayed value is tokens, not raw base units. The following `about` label only qualifies the multiplied amount, not this row.

Concrete failure: if a valid response contains `outRaw: "9007199254740993"` for an 8-decimal mint, the row begins from `9007199254740992` and displays a figure Jupiter did not quote. Keep `outRaw` as a string/`bigint`, render its token amount with `exactTokens`, call it “Tokens before ×”, and use the same program-fixed multiplier rule for the qualified wallet amount.

**MINOR — INSIDE — `app/src/components/assets/AssetDetail.tsx:69-80,247-260`:** the header's count claims to be how many of the eight powers “a key can use today”, but it counts a transfer hook only when its program is already set. The detail row correctly says that an enabled hook with no program can be set by its decoded authority. That authority is therefore a live issuer power omitted from the advertised count.

Concrete failure: a mint with a transfer-hook extension, a non-null authority, and no current hook program shows “N issuer powers” while its own dialog identifies an additional key able to install transfer logic. Count the non-null transfer-hook authority in that state, or narrow the header wording to count only currently active powers.

## U7

- Findings: **INSIDE 3, OUTSIDE 0**. This is indicative rather than a rigorous cold-read metric: the prompt and brief supplied the target, prior findings, and most intended behaviours (protocol U1).

## U8 — not checked

- I did not run an ops script, send a transaction, make live RPC/API reads, or read any keypair, `.env*` content, `~/.config/solana`, or `~/.config/othello-demo`. A presence-only check confirmed root `.env`, root `.env.local`, and `app/.env.local` are absent.
- I did not run `anchor build`, as instructed: it can read the local deploy keypair. The already-built target artifact was used by the serial bankrun specs.
- I did not reproduce browser-wallet signing, physical-device layout, deployment, or live devnet/mainnet/Jupiter/GeckoTerminal behaviour. I also did not make an unscoped review outside this target and its immediate protocol consumers.

## Verification (serial)

```text
git branch --show-current; git rev-parse --short HEAD
task/T18f-assets-design
adfe4d2

git diff --stat 1efc57e adfe4d2
reviews/t18f-brief.md | 83 +
1 file changed, 83 insertions(+)

corepack pnpm@10.32.1 install --frozen-lockfile
exit 0; lockfile up to date.

(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; lockfile up to date.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
44 files, one process per file: 254 passing, 0 failing.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next.js 15.5.26 compiled, type-checked, and generated 109 pages.

git diff --check 0f0b2b6..1efc57e
exit 0.

./scripts/check-secrets.sh
no credential-shaped strings in client output

test ! -e .env && test ! -e .env.local && test ! -e app/.env.local
exit 0; local env files absent (presence-only check).
```
