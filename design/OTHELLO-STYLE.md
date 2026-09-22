# Othello design style

The visual system behind `Landing.dc.html`. Build S4 Circle and S5 Join/Position from this.

## Principle

Material 3 expressive shape language (pill everything, large radii, tonal containers) rendered with
neubrutalist honesty (flat colour, 3px black outlines, hard offset shadows, no blur, no gradients
except one hover sheen). Every colour on the page derives from the user's chosen profile at runtime.

## Colour: one hue, two intensities

Nothing is a fixed light/dark pair. Each profile declares five accent hexes at full strength plus a
brand hue. Modes are solved, not authored.

- `huesFor(set, dark)` — dark mode uses the accents as declared; light mode is each accent mixed
  20% toward white, except slot 3 which is held at 4% so it stays a deep fill.
- `atLum(hex, target)` — binary-searches a mix toward black or white until the colour hits a target
  relative luminance. Hue and saturation survive, so grounds read as the colour, never as grey.
- `grounds(brand, dark)` — light: desk .82, paper .95, deep .035, grey .58, greyFill .90.
  dark: desk .075, paper .042 (frame darker than desk), deep .86, grey .20, greyFill .09.
- `inkFor(hex)` — per-slot text colour, black above .32 luminance, cream below. Published as
  `--acidInk`, `--skyInk`, `--cobaltInk`, `--tealInk`, `--clayInk`. **Any element filled with an
  accent must use that accent's ink var.** This is the rule that keeps every profile legible.

Slot roles: 1 Primary, 2 Secondary, 3 Deep (the dark fill, carries light text), 4 Support, 5 Accent.

Tokens applied to the root element: `--desk --paper --ink --muted --cream --chrome --grey --greyFill
--deep --deepInk` plus the five accents and their inks. `--chrome` never flips — it is the tape ground.

Recommended profiles: Signal (lime/cobalt), Bubblegum (pink/violet), Harbour (sand/navy),
Newsprint (stone/rust). Users add their own: pick all five slots or "Surprise me" from one hue,
name it, rename or delete later. Persisted under the single key `othello.theme`.

## Type

- Display and body: Plus Jakarta Sans, 800 for headings, 500–700 for body.
- Statement type: Archivo, `font-style:italic`, `font-stretch:68–70%`, weight 900, uppercase,
  `letter-spacing:-.02em`, `line-height:.9`. Reserved for the problem card, tile headlines and tapes.
- Hero `clamp(36px,6.6vw,86px)`, tile headline `clamp(25px,3.1vw,38px)`, body `clamp(16px,1.8vw,21px)`,
  micro labels 9.5–11px at 800 with `.12–.14em` tracking, uppercase.

## Shape

- Frame: 5px ink border, `clamp(24px,3.2vw,44px)` radius, no overflow clipping (tiles break out).
- Tiles: 3px border, `clamp(20px,2.6vw,32px)` radius, `3px 3px 0` ink shadow, `6px 6px 0` when active.
- Bento cards: 4px coloured offset shadows. Pills: `border-radius:999px`, 3px border, 44px min height.
- Micro pills: 2–3px border, 5–7px padding. Icon badges: 46–48px circles, `--paper` fill.
- Decoration: one motif per card, never repeated — half-disc, tilted bars, concentric rings, rotated
  rounded square. Always `pointer-events:none`, tinted `rgba(11,11,11,.09–.2)` or cream equivalent.
- Doodles: 5px round-capped strokes (squiggle, spiral), two per page, on `z-index:-1`.

## Motion

- Tiles track the pointer: `perspective(620px)` with ±20° rotation, 16px translate, 1.06 scale,
  100ms follow, 420ms spring release `cubic-bezier(.2,1.5,.35,1)`, `z-index:30` while active.
- Hover sheen: a 105° white-band gradient parked at `-140% 0`, swept once by `@keyframes sheen`.
  Entrance animations live on a **wrapper** so hover never replaces them (that flash was a real bug).
- Tapes: two counter-rotating ±5° marquees, `--chrome` and accent, 190% wide from -45% so the ends
  fall outside; band clips `overflow-x:clip; overflow-y:visible`.
- Stickers wobble, active icon ticks, seat 3 pulses. All inside `@media (prefers-reduced-motion:reduce)`.

## Layout

Fluid, no fixed widths. Frame maxes at 1240px. Nav is a three-column grid so the pill group shrinks
between logo and actions. Everything else is `flex-wrap` with `flex-basis` + `min-width:0`, or
`repeat(auto-fit,minmax(248px,1fr))`. Segmented controls scroll horizontally rather than overflow.

## Copy

All product strings come from `design/FLOWS.md` verbatim. The handoff deck never overrides design/.
No em-dashes, no "we", no invented numbers.
