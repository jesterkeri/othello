/**
 * T18d adversary: every palette x light/dark must render readable text (T18d requirement 5).
 *
 * The selected chips on the circle, seat and stock pages (Circle.module.css .stateOn and
 * .rangeOn, Screen.module.css .seatOn) paint var(--paper) text on var(--line). Inside the
 * Shell, --line is the .frame's constant black and --paper is the alias T18d added in
 * innerVars (theme.ts). This reads both rules from the CSS files and both colours from the
 * repo's own innerVars, so it follows whatever the code actually paints. The bar is 3:1,
 * already below WCAG's 4.5:1 for 10px text.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO } from "./artifacts.ts";
import { PALETTES, innerVars, lum } from "../app/src/lib/theme.ts";

const css = (p: string) => readFileSync(resolve(REPO, "app/src/components", p), "utf8");
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

// A colour token as the chip paints it: a hex literal, or a custom property resolved the way
// the page resolves it (the .frame's own --line first, then the Shell's innerVars).
function resolveToken(token: string, frame: Record<string, string>, vars: Record<string, string>): string {
  const hex = /#[0-9A-Fa-f]{6}/.exec(token)?.[0];
  if (hex) return hex;
  const name = /var\((--[A-Za-z]+)\)/.exec(token)?.[1];
  assert.ok(name, `cannot read colour token ${token}`);
  const value = frame[name] ?? vars[name];
  assert.ok(value, `${name} is not defined inside the Shell`);
  return value;
}

function chip(sheet: string, selector: string): { background: string; color: string } {
  const body = new RegExp(`\\.${selector}[^{]*\\{([^}]*)\\}`).exec(sheet)?.[1];
  assert.ok(body, `.${selector} rule exists`);
  const background = /background(?:-color)?:\s*([^;]+);/.exec(body)?.[1];
  const color = /(?:^|[;\s])color:\s*([^;]+);/.exec(body)?.[1];
  assert.ok(background && color, `.${selector} sets a background and a colour`);
  return { background, color };
}

describe("T18d adversary: selected chips stay readable in every palette and mode", () => {
  const circle = css("circle/Circle.module.css");
  const screen = css("ui/Screen.module.css");
  const frameBody = /\.frame\s*\{([^}]*)\}/.exec(circle)?.[1] ?? "";
  const frame: Record<string, string> = Object.fromEntries([...frameBody.matchAll(/(--[A-Za-z]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  const chips = [
    ["Circle.module.css .stateOn (the circle page's current state)", chip(circle, "stateOn")],
    ["Circle.module.css .rangeOn (the stock chart's current range)", chip(circle, "rangeOn")],
    ["Screen.module.css .seatOn (the seat page's current seat)", chip(screen, "seatOn")],
  ] as const;

  for (const p of PALETTES) {
    for (const dark of [false, true]) {
      it(`${p.name} ${dark ? "dark" : "light"}: every selected chip is at least 3:1`, () => {
        const v = innerVars(p, dark);
        for (const [where, c] of chips) {
          const bg = resolveToken(c.background, frame, v);
          const fg = resolveToken(c.color, frame, v);
          const cr = contrast(fg, bg);
          assert.ok(cr >= 3, `${where}: ${fg} text on ${bg} is ${cr.toFixed(2)}:1`);
        }
      });
    }
  }
});
