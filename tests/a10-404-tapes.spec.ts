/**
 * The 404 page's two tapes run edge to edge, under the rail, to both sides of the window (Joshua, 2026-10-09: "the
 * ribbon doesnt go to the end in the 404 page, it should be under the sidebar and go to the end"). They did not: their
 * margins cancelled Shell's .panel padding on the right and bottom only, so on desktop they stopped where the rail's
 * 112px gutter began.
 *
 * Pinned here: at every breakpoint, the .tapes margins in NotFound.module.css are exactly the negative of Shell's
 * .panel padding on the left, right and bottom (desktop), and on the left and right (phone, where the nav pill sits
 * below the tapes); nothing lifts the tapes or a tape over the rail. tests/a10-404-tapes-render-adversary.spec.ts
 * checks the rendered page (run by hand with A10_URL).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { REPO } from "./artifacts.ts";

const DIR = resolve(REPO, "app/src/components/othello");
const shell = readFileSync(join(DIR, "Shell.module.css"), "utf8");
const notFound = readFileSync(join(DIR, "NotFound.module.css"), "utf8");

/** Split a CSS shorthand into its top-level values (commas and spaces inside calc()/clamp() stay together). */
function values(shorthand: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of shorthand.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** top, right, bottom, left of a 1-4 value shorthand. */
function sides(shorthand: string): [string, string, string, string] {
  const v = values(shorthand);
  const [t, r = t, b = t, l = r] = v as [string, string?, string?, string?];
  return [t, r!, b!, l!];
}

/** The `prop` of the rule for `selector` in `css`: at top level, or inside the phone media query. */
function decl(css: string, selector: string, prop: string, phone: boolean): string {
  const scope = phone ? /@media \(max-width: 759px\) \{([\s\S]*?)\n\}|@media \(max-width: 759px\) \{([^\n]*)\}/.exec(css) : null;
  const text = phone ? (scope?.[1] ?? scope?.[2] ?? "") : css.replace(/@media[^{]*\{[\s\S]*?\n\}|@media[^{\n]*\{[^\n]*\}/g, "");
  const rule = new RegExp(`(?:^|\\s)\\${selector} \\{([^}]*)\\}`).exec(text);
  assert.ok(rule, `${selector} ${phone ? "(phone)" : "(desktop)"} not found`);
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(rule[1]!);
  assert.ok(m, `${selector} ${phone ? "(phone)" : "(desktop)"} has no ${prop}`);
  return m[1]!.trim();
}

const negate = (v: string) => (v === "0" ? "0" : /^\d+(\.\d+)?px$/.test(v) ? `-${v}` : `calc(-1 * ${v.replace(/^calc\((.*)\)$/, "($1)")})`);

describe("A10: the 404 tapes run edge to edge, under the rail", () => {
  it("desktop: the tapes cancel the panel's left (rail gutter), right and bottom padding", () => {
    const [, pr, pb, pl] = sides(decl(shell, ".panel", "padding", false));
    const [, mr, mb, ml] = sides(decl(notFound, ".tapes", "margin", false));
    assert.equal(mr, negate(pr), "right");
    assert.equal(mb, negate(pb), "bottom");
    assert.equal(ml, negate(pl), "left: the tapes must reach under the rail to the window's edge");
  });

  it("phone: the tapes cancel the panel's left and right padding", () => {
    const [, pr, , pl] = sides(decl(shell, ".panel", "padding", true));
    const [, mr, , ml] = sides(decl(notFound, ".tapes", "margin", true));
    assert.equal(mr, negate(pr), "right");
    assert.equal(ml, negate(pl), "left");
  });

  it("the tapes sit below the rail, which is fixed above the page", () => {
    assert.match(decl(shell, ".rail", "position", false), /^fixed$/);
    assert.match(decl(shell, ".rail", "z-index", false), /^\d+$/);
    // no rule for the tapes, a tape or its track, anywhere in the file (adversary on b212ead: a z-index on .tape lifted
    // the tapes over the rail and the first version of this check, which read only `.tapes {`, passed)
    for (const rule of notFound.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/\.(tapes?|tapeA|tapeB|track|back)\b/.test(rule[1]!)) assert.doesNotMatch(rule[2]!, /z-index|position:\s*(fixed|sticky)/, `${rule[1]!.trim()} must not rise above the rail`);
    }
  });

  it("every .tapes margin rule keeps the edge-to-edge margins (no later rule overrides them)", () => {
    for (const rule of notFound.matchAll(/(?:^|\n|\{\s*)\.tapes \{([^}]*)\}/g)) {
      assert.doesNotMatch(rule[1]!, /margin-(left|right)\s*:/, "a side margin longhand would override the edge-to-edge shorthand");
    }
    assert.equal([...notFound.matchAll(/\.tapes \{[^}]*\bmargin:/g)].length, 2, "one margin for desktop and one for phone");
  });
});
