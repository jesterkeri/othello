/**
 * T18f adversary: the issuer-powers dialog's tiles must be readable in every palette x mode
 * (T18f brief item 4: "its tiles are readable in every palette").
 *
 * AssetDetail.module.css paints each tile (tr) with a slot colour and its --<slot>Ink, then forces
 * every span inside the table to `color: inherit` (`.powers :global(span)`, specificity 0,1,1).
 * The status chips in a tile's value cell are Circle.module.css `.tag.tagNo` ("None", "Not
 * enabled", "No program set", "Nobody: authority revoked") and `.tag.tagDue` ("Paused now",
 * in the held tile). Those classes set their own background, but their `color`
 * (specificity 0,1,0) loses to the inherit rule, so the chip's text is the tile's ink on the
 * chip's own background. This reads the rules from the CSS files and the colours from the repo's
 * own innerVars, as t18d-shell-contrast-adversary.spec.ts does. The bar is 3:1.
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
const varName = (token: string) => {
  const name = /var\((--[A-Za-z]+)\)/.exec(token)?.[1];
  assert.ok(name, `cannot read colour token ${token}`);
  return name;
};
function rule(sheet: string, selector: string): string {
  const body = new RegExp(`${selector.replace(/[.()[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(sheet)?.[1];
  assert.ok(body, `${selector} rule exists`);
  return body;
}

describe("T18f adversary: issuer-powers tile chips stay readable in every palette and mode", () => {
  const detail = css("assets/AssetDetail.module.css");
  const circle = css("circle/Circle.module.css");
  // The inherit rule this test depends on: if it goes, the chips keep their own colours.
  const inherits = /\.powers\s+:global\(span\)\s*\{[^}]*color:\s*inherit/.test(detail);

  // Tile tone -> the slot whose ink the tile's text inherits (AssetDetail.module.css tr:has()).
  const tiles: Record<string, string> = {};
  for (const tone of ["toneHeld", "toneEnabled", "toneYes", "toneSafe"]) {
    const body = rule(detail, `.powers tr:has(.${tone})`);
    tiles[tone] = varName(/(?:^|[;\s])color:\s*([^;]+);/.exec(body)![1]!);
  }
  // Chips AssetDetail.tsx renders, and the tiles it renders them in.
  const chips: [string, string, string[]][] = [
    ["tagNo", "None / Not enabled / Nobody: authority revoked (safe tile)", ["toneSafe"]],
    ["tagNo", "No program set (transfer hook enabled, no program: enabled tile)", ["toneEnabled"]],
    ["tagDue", "Paused now (Pausable row, held tile)", ["toneHeld"]],
  ];

  for (const p of PALETTES) {
    for (const dark of [false, true]) {
      it(`${p.name} ${dark ? "dark" : "light"}: every chip in a powers tile is at least 3:1`, () => {
        const v = innerVars(p, dark);
        const bad: string[] = [];
        for (const [cls, text, tones] of chips) {
          const body = rule(circle, `.${cls}`);
          const bg = v[varName(/background:\s*([^;]+);/.exec(body)![1]!)]!;
          for (const tone of tones) {
            const fg = inherits ? v[tiles[tone]!]! : v[varName(/(?:^|[;\s])color:\s*([^;]+);/.exec(body)![1]!)]!;
            const cr = contrast(fg, bg);
            if (cr < 3) bad.push(`.${cls} "${text}" in a ${tone} tile: ${fg} on ${bg} is ${cr.toFixed(2)}:1`);
          }
        }
        assert.deepEqual(bad, []);
      });
    }
  }
});
