/**
 * The first frame's colours (lib/theme-boot.ts, lib/theme.ts cacheThemeVars). Joshua, 2026-10-06: every page first
 * drew the default palette, then switched to the visitor's. The fix caches the stored theme's resolved variables and
 * a head script paints them before the body is parsed. These cases run that script against a stand-in document.
 *
 *   npx mocha --import=tsx tests/a6-theme-first-paint.spec.ts
 */
import assert from "node:assert/strict";

import { PALETTES, STORAGE_KEY, VARS_KEY, cacheThemeVars, innerVars, saveTheme, themeVars } from "../app/src/lib/theme.ts";
import { paintStoredTheme, screenDefaults } from "../app/src/lib/theme-boot.ts";

type FakeStyle = { id: string; textContent: string };

/** A stand-in for the bits of the browser the script and cacheThemeVars touch. */
function browser(stored: Record<string, string> = {}) {
  const items = new Map(Object.entries(stored));
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

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g["localStorage"];
  delete g["document"];
});

describe("a6 theme first paint", () => {
  it("paints a returning visitor's palette and mode, for both kinds of screen", () => {
    const newsprint = PALETTES[3]!;
    const b = browser();
    saveTheme({ choice: "r3", theme: "light", custom: [] });
    cacheThemeVars(newsprint, "light");
    assert.equal(b.html.dataset["mode"], "light", "cacheThemeVars marks the document's mode");
    b.html.dataset = {};
    b.appended.length = 0;
    b.run();
    assert.equal(b.appended.length, 1);
    const css = b.appended[0]!.textContent;
    const inner = innerVars(newsprint, false);
    const landing = themeVars(newsprint, false);
    assert.ok(css.includes(`[data-tk=inner]{`) && css.includes(`--acid:${inner["--acid"]};`), css);
    assert.ok(css.includes(`[data-tk=landing]{`) && css.includes(`--acid:${landing["--acid"]};`), css);
    assert.ok(css.includes(`:root{--ink:${landing["--ink"]};`), "the body and overscroll take Landing's variables");
    assert.ok(css.includes(`body:has([data-tk=inner]){background:${inner["--panel"]}}`), "the shell's panel behind the page");
    assert.equal(b.html.dataset["mode"], "light");
    assert.equal(b.html.style["colorScheme"], "light");
  });

  it("leaves the defaults alone for a first visit, a cleared cache or a broken one", () => {
    for (const stored of [{}, { [VARS_KEY]: "not json" }, { [STORAGE_KEY]: "not json" }, { [STORAGE_KEY]: JSON.stringify({ choice: "c4", theme: "light", custom: [] }) }]) {
      const b = browser(stored);
      assert.doesNotThrow(() => b.run());
      assert.equal(b.appended.length, 0, JSON.stringify(stored));
      assert.equal(b.html.dataset["mode"], undefined);
    }
  });

  it("paints only custom-property names with plain colour values", () => {
    const theme = JSON.stringify({ choice: "c0", theme: "dark", custom: [{ name: "x", hues: ["#123456", "#123456", "#123456", "#123456", "#123456"] }] });
    const b = browser({
      [STORAGE_KEY]: theme,
      [VARS_KEY]: JSON.stringify({
        key: theme,
        mode: "dark<script>",
        inner: { "--acid": "#123456", "--teal": "red;}body{display:none", "--panel": "#000;}x{", "color": "#fff" },
        landing: { "--ink": "#FBF9F2", "--sky": "url(https://example.com/x)" },
      }),
    });
    b.run();
    const css = b.appended[0]!.textContent;
    assert.ok(css.includes("--acid:#123456;"));
    assert.ok(!css.includes("display:none") && !css.includes("--teal"), css);
    assert.ok(!css.includes("color:#fff") && !css.includes("url("), css);
    assert.ok(!css.includes("body:has"), "an unsafe panel value paints no body rule");
    assert.equal(b.html.dataset["mode"], "dark", "anything but light is dark");
  });

  it("gives each screen its own first-visit default", () => {
    assert.ok(screenDefaults.startsWith(`[data-tk=inner]{--line:#0B0B0B;`));
    assert.ok(screenDefaults.includes(`[data-tk=wallet]{--line:#0B0B0B;`), "Landing's wallet control takes the shell's variables");
    assert.ok(screenDefaults.includes(`--acid:${innerVars(PALETTES[1]!, true)["--acid"]}`), "the shell: Bubblegum dark");
    assert.ok(screenDefaults.includes(`[data-tk=landing]{--ink:#0B0B0B;`), "Landing: Signal light");
  });

  it("ignores a cache made from a different stored theme and resolves the stored one", () => {
    const harbour = PALETTES[2]!;
    const b = browser();
    saveTheme({ choice: "r3", theme: "light", custom: [] });
    cacheThemeVars(PALETTES[3]!, "light");
    // the theme changes somewhere that did not refresh the cache (an older tab, a hand edit)
    saveTheme({ choice: "r2", theme: "dark", custom: [] });
    b.appended.length = 0;
    b.run();
    const css = b.appended[0]!.textContent;
    assert.ok(css.includes(`--panel:${innerVars(harbour, true)["--panel"]};`), css);
    assert.ok(css.includes(`--desk:${themeVars(harbour, true)["--desk"]};`), css);
    assert.equal(b.html.dataset["mode"], "dark");
  });
});
