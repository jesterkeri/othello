/**
 * The site's fonts are served from the repo, never fetched from Google at build time (Joshua, 2026-10-08). On
 * 2026-10-08 Google began answering GitHub's CI machines with font links next/font/google cannot parse
 * (loader.js:122, "Cannot read properties of null (reading '1')"), and every branch's full-build tests failed.
 *
 * Pinned here: nothing in app/src imports next/font/google; app/src/app/fonts.css names only files that exist in
 * app/public/fonts and are real woff2; every bundled font is used; the files layout.tsx preloads exist and are the
 * latin ones; both SIL OFL licences ship next to the fonts. (Before the switch, the ten files were checked byte for
 * byte against the ones next/font/google downloaded, and six pages screenshotted identical, at 1280 and 390 px.)
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { REPO } from "./artifacts.ts";

const APP = resolve(REPO, "app");
const FONTS = join(APP, "public/fonts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css|mjs)$/.test(name) ? [path] : [];
  });
}

describe("A9: the fonts are the repo's own", () => {
  const css = readFileSync(join(APP, "src/app/fonts.css"), "utf8");
  const named = [...css.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map((m) => m[1]!);

  it("nothing in the app fetches fonts from Google", () => {
    const offenders = [...sources(join(APP, "src")), join(APP, "next.config.mjs")].filter((p) =>
      // an import of it, or a Google font URL (comments may name next/font/google to say why it is gone)
      /from\s+["']next\/font\/google["']|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(readFileSync(p, "utf8")),
    );
    assert.deepEqual(offenders, []);
  });

  it("fonts.css names only bundled woff2 files, and every bundled font is used", () => {
    assert.ok(named.length >= 10, `fonts.css names ${named.length} files`);
    for (const f of new Set(named)) {
      const path = join(FONTS, f);
      assert.ok(existsSync(path), `fonts.css names ${f}, which is not in app/public/fonts`);
      assert.equal(readFileSync(path).subarray(0, 4).toString("latin1"), "wOF2", `${f} is not a woff2 file`);
    }
    const bundled = readdirSync(FONTS).filter((f) => f.endsWith(".woff2"));
    assert.deepEqual(bundled.sort(), [...new Set(named)].sort(), "a bundled font is unused, or a named one missing");
  });

  it("both families keep their CSS variables and Arial fallback metrics", () => {
    assert.match(css, /--font-archivo:\s*"Archivo", "Archivo Fallback"/);
    assert.match(css, /--font-jakarta:\s*"Plus Jakarta Sans", "Plus Jakarta Sans Fallback"/);
    for (const family of ["Archivo Fallback", "Plus Jakarta Sans Fallback"]) {
      assert.match(css, new RegExp(`font-family: ${family};\\s*src: local\\("Arial"\\);\\s*ascent-override`), `${family} fallback`);
    }
    assert.match(css, /font-stretch: 62% 125%/, "Archivo keeps its wdth axis (OTHELLO-STYLE.md, Type)");
  });

  it("the layout imports fonts.css and preloads the three latin files, which exist", () => {
    const layout = readFileSync(join(APP, "src/app/layout.tsx"), "utf8");
    assert.match(layout, /import "\.\/fonts\.css";/);
    const preloaded = JSON.parse(/const PRELOADED_FONTS = (\[[^\]]*\])/.exec(layout)![1]!) as string[];
    assert.deepEqual(preloaded.sort(), ["archivo-latin-italic.woff2", "archivo-latin.woff2", "plus-jakarta-sans-latin.woff2"]);
    for (const f of preloaded) assert.ok(existsSync(join(FONTS, f)), `${f} is preloaded but missing`);
  });

  it("the SIL Open Font License ships with each family", () => {
    for (const f of ["OFL-Archivo.txt", "OFL-PlusJakartaSans.txt"]) {
      assert.match(readFileSync(join(FONTS, f), "utf8"), /SIL Open Font License, Version 1\.1/);
    }
  });
});
