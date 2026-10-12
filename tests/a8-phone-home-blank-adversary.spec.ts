/**
 * Adversary, A8 no landing page on phones (Joshua, 2026-10-08), pass on 5422cbc (PR #31). The spec: on a phone the
 * home page "never shows the landing page and opens the circles instead", and "No dead ends: a phone user must never
 * land on a blank page".
 *
 * Since 5422cbc, `/` is prerendered with the landing inside a wrapper that home.module.css hides at max-width 759px,
 * and nothing else: the move to /circles is a router.replace in an effect, so it happens only after the page's
 * JavaScript has downloaded and hydrated. Until then a phone shows the empty body, and if the bundle never runs (a
 * dropped chunk, a script blocker, JavaScript off) it stays empty. Measured on the built app (`next start`, headless
 * Chromium at 390 px, Chrome DevTools' Slow 4G preset): first paint at 1.7 s with no visible text, /circles at 6.2 s.
 * The same HTML on a desktop paints the landing straight away.
 *
 * This renders the real prerendered `/` (app/.next/server/app/index.html, from `pnpm -C app build`) with the build's
 * own stylesheets inlined and its script bundles left out: what the browser has painted before any of them has run.
 * It reads the text a person can see (innerText skips display:none) at 390 px and, as a control, at 1280 px.
 * Browser: $CHROME, else Playwright's cached chrome-headless-shell, else Windows Chrome under WSL.
 *
 *   pnpm -C app build && npx mocha --import=tsx --timeout 300000 tests/a8-phone-home-blank-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const APP = resolve(REPO, "app");
const INDEX = resolve(APP, ".next/server/app/index.html");

/** Browsers: $CHROME, Playwright's cached chrome-headless-shell, then Windows Chrome under WSL (as tests/a6-theme-modal-other-tab-adversary.spec.ts). */
function browsers(): { bin: string; windows: boolean }[] {
  const out: { bin: string; windows: boolean }[] = [];
  if (process.env.CHROME) out.push({ bin: process.env.CHROME, windows: process.env.CHROME.endsWith(".exe") });
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const d of existsSync(cache) ? readdirSync(cache) : []) {
    const bin = join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (d.startsWith("chromium_headless_shell") && existsSync(bin)) out.push({ bin, windows: false });
  }
  const win = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
  if (existsSync(win)) out.push({ bin: win, windows: true });
  return out;
}

/** A path as the browser sees it: a Windows browser under WSL reads WSL files through \\wsl.localhost. */
function forBrowser(path: string, windows: boolean): string {
  if (!windows) return path;
  const w = spawnSync("wslpath", ["-w", path], { encoding: "utf8" }).stdout.trim();
  assert.ok(w, `wslpath gave nothing for ${path}`);
  return w;
}

/** The prerendered home page as painted before its bundles run: build CSS inlined, external scripts removed. */
function prerendered(): string {
  assert.ok(existsSync(INDEX), `no prerendered home page at ${INDEX}: run pnpm -C app build first`);
  const built = statSync(INDEX).mtimeMs;
  for (const src of ["src/app/page.tsx", "src/app/home.module.css", "src/app/layout.tsx", "src/components/landing/Landing.tsx"]) {
    const p = resolve(APP, src);
    if (existsSync(p)) assert.ok(statSync(p).mtimeMs <= built, `${src} is newer than the build: run pnpm -C app build again`);
  }
  let html = readFileSync(INDEX, "utf8");
  html = html.replace(/<link rel="stylesheet" href="\/_next\/static\/css\/([^"]+)"[^>]*\/?>/g, (_, f: string) => {
    const css = resolve(APP, ".next/static/css", f);
    assert.ok(existsSync(css), `the build's stylesheet ${f} is missing`);
    return `<style>${readFileSync(css, "utf8")}</style>`;
  });
  assert.ok(!/<link rel="stylesheet"/.test(html), "precondition: every stylesheet is inlined");
  html = html.replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, "");
  const probe = `<script>addEventListener("load",function(){var t=document.body.innerText.trim();` +
    `var o=document.createElement("pre");o.id="a8-out";o.hidden=true;` +
    `o.textContent=JSON.stringify({visible:t.slice(0,200),width:innerWidth,landing:!!document.querySelector("[data-tk=landing]")});document.body.appendChild(o)})</script>`;
  return html.replace("</body>", `${probe}</body>`);
}

const leftovers: string[] = [];
after(() => {
  for (const dir of leftovers) rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
});

type Out = { visible: string; width: number; landing: boolean };

function paint(html: string, width: number): Out {
  const errors: string[] = [];
  for (const { bin, windows } of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a8-blank-"));
    try {
      const file = join(dir, "index.html");
      writeFileSync(file, html);
      const url = windows ? "file:" + forBrowser(file, true).replace(/\\/g, "/") : pathToFileURL(file).href;
      const r = spawnSync(bin, [windows ? "--headless=new" : "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${forBrowser(join(dir, "profile"), windows)}`, `--window-size=${width},844`, "--virtual-time-budget=5000", "--dump-dom", url],
        { encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
      const m = (r.stdout ?? "").match(/<pre id="a8-out" hidden="">([\s\S]*?)<\/pre>/);
      if (m) return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      errors.push(`${bin} (status ${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { leftovers.push(dir); }
    }
  }
  throw new Error(`no Chromium ran; set CHROME to a chrome or chrome-headless-shell binary.\n${errors.join("\n")}`);
}

describe("A8 adversary: the home page on a phone before its JavaScript runs", function () {
  this.timeout(300_000);

  it("a phone opening / sees something, not an empty page, until it reaches the circles", () => {
    const html = prerendered();
    const desk = paint(html, 1280);
    assert.equal(desk.width, 1280, "precondition: the desktop window is 1280 px wide");
    assert.ok(desk.landing && desk.visible.length > 0, `precondition: the same HTML on a desktop paints the landing (saw ${JSON.stringify(desk.visible)})`);
    const phone = paint(html, 390);
    assert.equal(phone.width, 390, "precondition: the phone window is 390 px wide, inside max-width 759px");
    assert.notEqual(phone.visible, "", "a phone opening / is shown an empty page until the bundle hydrates and router.replace('/circles') runs; if it never runs, the page stays empty");
  });
});
