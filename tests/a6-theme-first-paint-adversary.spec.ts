/**
 * Adversary, A6 theme first paint (Joshua, 2026-10-06), pass on 8f0db93. The spec: "A returning visitor who has a
 * stored theme (localStorage key `othello.theme`: {choice, theme, custom}) must see their own palette and mode from the
 * very first painted frame on every page ... The default palette must never be painted first and then swapped." and
 * "Changing palette or mode in the picker ... must still take effect, and the next page load must open in the new
 * choice, with no flash."
 *
 * The real head script (lib/theme-boot.ts paintStoredTheme) runs against a stand-in document, as
 * tests/a6-theme-first-paint.spec.ts does; the stored values are written by the repo's own saveTheme and cacheThemeVars
 * (lib/theme.ts), nothing hand-made. What a screen root without inline variables (Shell before `ready`, Landing before
 * `hydrated`) takes is read from the rules the document actually holds: layout.tsx's screenDefaults, then whatever the
 * script appended, later rules winning.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-theme-first-paint-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { PALETTES, cacheThemeVars, innerVars, saveTheme, themeVars } from "../app/src/lib/theme.ts";
import { paintStoredTheme, screenDefaults } from "../app/src/lib/theme-boot.ts";

type FakeStyle = { id: string; textContent: string };

/** A stand-in for the bits of the browser the script, saveTheme and cacheThemeVars touch. */
function browser() {
  const items = new Map<string, string>();
  const appended: FakeStyle[] = [];
  const html = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const g = globalThis as unknown as Record<string, unknown>;
  g["localStorage"] = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
  g["document"] = {
    documentElement: html,
    head: { appendChild: (s: FakeStyle) => void appended.push(s) },
    createElement: () => ({ id: "", textContent: "" }),
  };
  return { items, appended, html, run: () => new Function(paintStoredTheme)() };
}

/** The value a [data-tk=<kind>] root with no inline style takes for `name`: the last matching rule in the head wins. */
function firstFrame(appended: FakeStyle[], kind: "inner" | "landing", name: string): string | undefined {
  const sheet = screenDefaults + appended.map((s) => s.textContent).join("");
  let out: string | undefined;
  for (const m of sheet.matchAll(new RegExp(`\\[data-tk=${kind}\\]\\{([^}]*)\\}`, "g"))) {
    for (const decl of m[1]!.split(";")) {
      const i = decl.indexOf(":");
      if (decl.slice(0, i) === name) out = decl.slice(i + 1);
    }
  }
  return out;
}

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g["localStorage"];
  delete g["document"];
});

describe("a6 theme first paint, adversary", () => {
  it("a visitor whose theme was stored before this change opens in it, not in the default", () => {
    // Every visitor who picked a palette before 8f0db93 holds `othello.theme` and no `othello.theme.vars`.
    const newsprint = PALETTES[3]!;
    const b = browser();
    saveTheme({ choice: "r3", theme: "light", custom: [] });
    b.run();
    assert.equal(firstFrame(b.appended, "inner", "--panel"), innerVars(newsprint, false)["--panel"],
      "a shell page's first frame paints the visitor's Newsprint light panel");
    assert.equal(firstFrame(b.appended, "landing", "--desk"), themeVars(newsprint, false)["--desk"],
      "Landing's first frame paints the visitor's Newsprint light desk");
  });

  it("a palette picked on Landing is what the next shell page paints first, after a client-side navigation", () => {
    // First visit: nothing stored, the head script paints nothing (Landing's Signal light default stands).
    const newsprint = PALETTES[3]!;
    const b = browser();
    b.run();
    // The visitor picks Newsprint, light, on Landing: Landing's effects call saveTheme and cacheThemeVars.
    saveTheme({ choice: "r3", theme: "light", custom: [] });
    cacheThemeVars(newsprint, "light");
    // Then follows a link to a shell page. No reload, so the head script does not run again; the Shell's root renders
    // with no inline variables until its effect sets `ready`.
    assert.equal(b.html.dataset["mode"], "light", "precondition: the rail already reads light from <html>");
    assert.equal(firstFrame(b.appended, "inner", "--panel"), innerVars(newsprint, false)["--panel"],
      "the shell page's first frame paints the Newsprint light panel the visitor just picked");
  });
});
