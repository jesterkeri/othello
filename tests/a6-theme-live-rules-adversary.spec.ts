/**
 * Adversary, A6 theme first paint (Joshua, 2026-10-06), pass on f51734a. The spec: "Values read from localStorage must
 * never inject arbitrary CSS or script into the page."
 *
 * The head script (lib/theme-boot.ts paintStoredTheme) filters every name and value it paints. The live rules do not
 * pass through it: Shell.tsx useTheme, Landing.tsx and ThemeRoot.tsx call lib/theme.ts cacheThemeVars with the profile
 * they resolved from `othello.theme`, and cacheThemeVars writes themeRules(inner, landing) straight into the head
 * stylesheet's textContent. A custom palette's hues reach that text unchanged (innerVars and themeVars copy the dark
 * hues as declared), so a hue that closes the declaration block adds a rule of its own.
 *
 * The stored theme is written with the repo's own saveTheme and read back with loadTheme and customToProfile, the same
 * calls Shell.tsx makes on mount. The stand-in document is the one tests/a6-theme-first-paint.spec.ts uses, plus
 * getElementById so cacheThemeVars finds or creates its style element as it does in a browser.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-theme-live-rules-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { THEME_STYLE_ID, cacheThemeVars, customToProfile, loadTheme, saveTheme } from "../app/src/lib/theme.ts";

type FakeStyle = { id: string; textContent: string };

function browser() {
  const items = new Map<string, string>();
  const appended: FakeStyle[] = [];
  const html = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const g = globalThis as unknown as Record<string, unknown>;
  g["window"] = globalThis;
  g["localStorage"] = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
  g["document"] = {
    documentElement: html,
    head: { appendChild: (s: FakeStyle) => void appended.push(s) },
    createElement: () => ({ id: "", textContent: "" }),
    getElementById: (id: string) => appended.find((s) => s.id === id) ?? null,
  };
  return { appended };
}

/** The top-level selectors of a stylesheet, read the way a CSS parser does: a block ends at its first "}". */
function topLevelSelectors(css: string): string[] {
  const out: string[] = [];
  let rest = css;
  while (rest.length) {
    const open = rest.indexOf("{");
    if (open < 0) break;
    out.push(rest.slice(0, open));
    const close = rest.indexOf("}", open);
    if (close < 0) break;
    rest = rest.slice(close + 1);
  }
  return out;
}

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g["window"];
  delete g["localStorage"];
  delete g["document"];
});

describe("a6 theme live rules, adversary", () => {
  it("a custom hue from storage cannot add a rule to the head stylesheet", () => {
    const b = browser();
    // A tampered stored theme: one custom palette whose Primary hue closes its declaration block.
    const hostile = "#0B0B0B;}body{display:none}[data-x]{--z:0";
    saveTheme({ choice: "c0", theme: "dark", custom: [{ name: "x", hues: [hostile, "#7FC4EE", "#2B3BEF", "#12A594", "#E2552B"] }] });
    // What Shell.tsx useTheme does once it has read the stored theme. (Fix pass on f51734a: loadTheme now drops the
    // palette, so the hostile profile is also handed to cacheThemeVars directly: the head rules must filter it too.)
    const saved = loadTheme()!;
    assert.equal(saved.custom.length, 0, "loadTheme drops a custom palette whose hues are not plain hex");
    assert.equal(saved.choice, "r0", "and the choice that named it falls back to the first built-in");
    const profile = customToProfile({ name: "x", hues: [hostile, "#7FC4EE", "#2B3BEF", "#12A594", "#E2552B"] }, 0);
    cacheThemeVars(profile, "dark");

    const sheet = b.appended.find((s) => s.id === THEME_STYLE_ID);
    assert.ok(sheet, "precondition: cacheThemeVars wrote the head stylesheet");
    const allowed = new Set([":root", "[data-tk=landing]", "[data-tk=inner]", "[data-tk=wallet]", "body:has([data-tk=inner])"]);
    const extra = topLevelSelectors(sheet.textContent).filter((sel) => !allowed.has(sel));
    assert.deepEqual(extra, [], "the head stylesheet holds only the theme's own rules");
  });
});
