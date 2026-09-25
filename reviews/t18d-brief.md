# T18d review brief: one Shell, phones, and the actions anyone may send

Joshua, on submission day: the pages did not look like one product, content left the screen on
phones, and a judge could look at the demo circle but not do anything in it (the app sent one
instruction, `contribute`, members only). This branch puts every app page in the one Shell,
makes every page fit a 360px phone, and adds the three instructions SPEC §5 lets anyone send.

## Review target

| | |
|---|---|
| branch | `task/T18d-shell` |
| commit | `d0afc33` |
| range | `ec574c3..d0afc33` (T18c's approved tip, to this commit): 22 files, +769 / −231 |
| spec files, each in its own process | 40 files, 236 passing, 0 failing |

`37e4212` in the range only merges T18c's r5 verdict file. Commits after `d0afc33` change only
this file. T18c (`d7d137a`) is implementation-ready (reviews/t18c-review.md); not in scope.

Review under `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9.

## 1. The requirement

- Every app page except the landing page (/) renders inside `components/othello/Shell.tsx`:
  one nav, one logo, one wallet button. Every palette x light/dark is readable.
- At 360 and 390 px no page (except /, and the 404's decorative ticker) has sideways scroll or
  content past the viewport edge; tables become labelled cards; nothing covers the nav.
- Real data or a clear error; no false statement. Money on the devnet demo is "test USDC";
  the stock is the labelled NFLXx devnet mirror; mainnet pages say "Mainnet, read only".
- SPEC §5: `release_pot` (anyone; every seat paid or defaulted; all Member accounts writable
  in turn order), `update_coverage` (anyone; Active), `declare_default(turn)` (anyone; strictly
  after deadline + grace; seat unpaid, received, not defaulted). The app builds them from the
  deployed IDL, signs only in the visitor's wallet, never holds a key, enables a button only
  when the program's conditions hold by the last read, and shows a refusal in the program's own
  words. One transaction at a time.

## 2. What changed

| where | what |
|---|---|
| `components/othello/Shell.tsx`, `Shell.module.css` | frameless Shell (rail / phone pill), `network` prop for mainnet pages, sets `color-scheme` |
| `lib/theme.ts`, `lib/nav.ts` | token aliases (--paper, --ink, --muted, --greyFill); Stocks nav item; `'window' in globalThis` |
| `components/circle/*`, `position`, `join`, `live/LiveSeat`, `assets/Shell` | moved from ThemeRoot into the Shell; duplicate logo, viewer pill, devnet pill removed |
| `Circle.module.css`, `Screen.module.css`, `Create.module.css`, `Landing.module.css` | phone: table cards (data-label), wrapping timeline, pill/value wrapping; selected chips cream on black; Create's bar above the pill |
| `components/circle/Circle.tsx` | live member rows and "Not joined" open the live seat pages |
| `components/position/Position.tsx` | "Last checked: Not yet" when last_coverage_at is 0 (was "20721d ago") |
| `lib/actions.ts`, `components/live/LiveCircle.tsx` | release_pot, update_coverage, declare_default, for any connected wallet |
| tests | `app-actions` (bankrun, devnet build), `app-position-coverage-age`, `t18d-shell-contrast-adversary`; wallet stub widened in two harnesses (assertions unchanged) |

## 3. Already attacked

Adversary pass 1 on `80c1fac`: three defects, all fixed in `d0afc33` (dark-mode range buttons on
the browser's light fill; selected chips 1.15:1 in dark; /circle/new's bar over the nav pill),
its contrast test integrated. Adversary pass 2 on `d0afc33` (the actions) is running while you
review; if it proves a defect, the fix comes as r2.

## 4. How to run it

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/hr/myvscode_linux/othello-t18d
git branch --show-current   # must print task/T18d-shell; do not check out anything else
corepack pnpm@10.32.1 install --frozen-lockfile && (cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
anchor build
for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 600000 "$f"; done
pnpm exec tsc --noEmit -p tsconfig.json
(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
git diff --check ec574c3..d0afc33
./scripts/check-secrets.sh && ./scripts/check-reviews.sh
```

Read-only requests to devnet, mainnet, Jupiter and GeckoTerminal are fine, sparingly. Never send a
transaction, never run the ops scripts against devnet, never read a keypair, any .env* file,
~/.config/solana or ~/.config/othello-demo.

## 5. Thin, stated rather than discovered

- The buttons' enabled state is not unit-tested; the instructions are (bankrun, stranger's
  wallet, success and each refusal). Pages are checked by headless Chromium (phone overflow at
  360/390 on every route, nav not covered, 4 palettes x light/dark x widths).
- A visitor needs devnet SOL for the fee; the panel says so and names the faucet.
- The browser clock decides when "Declare X in default" appears; if devnet's clock is behind,
  the program refuses with GraceNotElapsed, shown as such.

## 6. Output

Write `reviews/t18d-review.md`. FIRST line exactly `VERDICT: implementation-ready` or
`VERDICT: changes required`; then findings with severity (BLOCKER / MAJOR / MINOR), INSIDE or
OUTSIDE, file:line and a concrete failure scenario; U7; U8; and the verification commands with
their real output.
