/**
 * Adversary, A5 ring entrance (product owner, 2026-10-05), pass on 9c8dda1. Spec item 1: "The entrance opens as the
 * Othello logo: three discs and a lime centre (the brand lime on every palette), no labels at all (no seat words,
 * numbers, badges, "Receives" marker, pot text); the labels appear as the arcs draw".
 *
 * Same harness as tests/a5-ring-logo-labels-adversary.spec.ts (the real CircleRing.tsx rendered with react-dom/server,
 * entrance on, in the page's real hero, laid out in a real Chromium), but the probe reads the figure's own caption, the
 * line drawn directly under the logo, instead of only the text inside .ring. The ring comes from the repo's own ringOf
 * over a constructed Active read of n=3, round 1, so ringOf's caption is "Round 2 of 3: Seat 2 receives 6 USDG": a
 * seat word, numbers and the pot. RobinhoodCircle.tsx mounts the ring with this caption on every load.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-ring-logo-caption-adversary.spec.ts
 *
 * Installs module loader hooks: run in its own mocha process.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { ringOf } from "../app/src/lib/robinhood/circle-view.ts";
import { PALETTES, themeVars } from "../app/src/lib/theme.ts";
import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const RING = resolve(SRC, "components/robinhood/CircleRing.tsx");
const CSS_FILES = {
  Circle: resolve(SRC, "components/circle/Circle.module.css"),
  Robinhood: resolve(SRC, "components/robinhood/Robinhood.module.css"),
  CircleRing: resolve(SRC, "components/robinhood/CircleRing.module.css"),
};
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));
const g = globalThis as { React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      const mod = basename(specifier, ".module.css");
      const src = `export default new Proxy({}, { get: (_, k) => typeof k === "string" ? ${JSON.stringify(mod)} + "_" + k : undefined });`;
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
        if (existsSync(base + ext) && statSync(base + ext).isFile()) return next(pathToFileURL(base + ext).href, context);
      }
    }
    return next(specifier, context);
  },
});

const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;
const seat = (turn: number, received: boolean): RhSeat => ({ turn, wallet: W(turn), collateral: 10n * U, g: U, topUps: 0n, forfeited: 0n,
  allocated: 0n, lastCoverageBps: 0, delinquentMarks: 0, roundsPaid: 0, joined: true, paid: false, received, defaulted: false, marked: false,
  withdrawn: false });
const read: RhCircleView = {
  address: W(9), factory: W(8), creator: W(0), n: 3, c: 2n * U, g: U, minStockCover: 10n * U, haircutBps: 1000, coverageBps: 10000, warnBps: 0,
  roundSecs: 86_400, graceSecs: 3_600, status: "Active", round: 1, deadline: 2_000_000, reserveTotal: 0n, reserveLosses: 0n, reserveAllocated: 0n,
  escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n, collateralReturned: 0n, depositsTotal: 0n, forfeitedTotal: 0n, nextGateShortBy: 0n,
  heldContributions: 0n, lastCoverageAt: 0, balance: 0n, surplus: 0n, seats: [0, 1, 2].map((t) => seat(t, t < 1)), readAt: 1_000_000,
  chainTime: 1_000_000, block: 1,
};

const scoped = (mod: string, css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\.([a-zA-Z_][\w-]*)/g, `.${mod}_$1`);

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
function forBrowser(path: string, windows: boolean): string {
  if (!windows) return path;
  const w = spawnSync("wslpath", ["-w", path], { encoding: "utf8" }).stdout.trim();
  assert.ok(w, `wslpath gave nothing for ${path}`);
  return w;
}
const fileUrl = (path: string, windows: boolean) => (windows ? "file:" + forBrowser(path, true).replace(/\\/g, "/") : pathToFileURL(path).href);

/** The figure's caption, if painted: shown, visible, no ancestor at opacity 0, a non-empty box. */
const PROBE = `
  const cap = document.querySelector('figcaption');
  const painted = (el) => {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  };
  const shown = cap && painted(cap) && cap.textContent.trim() ? [cap.textContent.trim()] : [];
  const fig = document.querySelector('figure').className;
  const pre = document.createElement('pre'); pre.id = 'ring-out'; pre.textContent = JSON.stringify({ fig, shown }); document.body.appendChild(pre);`;

function probe(markup: string, width: number): { fig: string; shown: string[] } {
  const css = ":root { --font-jakarta: 'Plus Jakarta Sans'; --font-archivo: Archivo; " +
    Object.entries(themeVars(PALETTES[0]!, false)).map(([k, v]) => `${k}: ${v};`).join(" ") + " }\n" +
    readFileSync(resolve(SRC, "app/globals.css"), "utf8") + "\n" +
    Object.entries(CSS_FILES).map(([m, f]) => scoped(m, readFileSync(f, "utf8"))).join("\n") + "\nbody { margin: 0; padding: 16px; }\n";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}"><style>${css}</style></head>` +
    `<body style="width:${width - 32}px"><section class="Circle_hero Robinhood_ringHero"><div class="Robinhood_ringCol">${markup}</div>` +
    `<div class="Circle_heroMain"></div></section><script>${PROBE}</script></body></html>`;
  const errors: string[] = [];
  for (const b of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a5-ring-caption-"));
    try {
      const file = join(dir, "ring.html");
      writeFileSync(file, html);
      const r = spawnSync(b.bin, [b.windows ? "--headless=new" : "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
        "--no-first-run", "--disable-extensions", "--force-device-scale-factor=1", `--user-data-dir=${forBrowser(join(dir, "profile"), b.windows)}`,
        `--window-size=${width},1400`, "--virtual-time-budget=3000", "--dump-dom", fileUrl(file, b.windows)], { encoding: "utf8", timeout: 90_000 });
      const json = /<pre id="ring-out">([^<]*)<\/pre>/.exec(r.stdout ?? "")?.[1];
      if (json) return JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      errors.push(`${b.bin} (status ${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`no Chromium ran; set CHROME to a chrome or chrome-headless-shell binary.\n${errors.join("\n")}`);
}

describe("A5 adversary (9c8dda1): the logo frame carries no caption either", () => {
  let React: { createElement: (...a: unknown[]) => unknown };
  let render: (el: unknown) => string;
  let CircleRing: unknown;
  const ring = ringOf(read, null);
  before(async () => {
    React = appRequire("react");
    g.React = React;
    render = appRequire("react-dom/server").renderToStaticMarkup;
    CircleRing = (await import(pathToFileURL(RING).href)).default;
  });

  it("precondition: ringOf's caption names a seat, numbers and the pot", () => {
    assert.match(ring.caption, /Seat 2/);
    assert.match(ring.caption, /USDG/);
  });

  it("control: the settled ring paints its caption (the probe sees it when it is there)", () => {
    const out = probe(render(React.createElement(CircleRing, { entrance: false, ring, pot: 6n * U, round: 1 })), 1280);
    assert.match(out.fig, /CircleRing_ready/);
    assert.deepEqual(out.shown, [ring.caption]);
  });

  for (const width of [1280, 360]) {
    it(`${width}px: the first frame of the entrance (the logo) paints no caption under it`, () => {
      const out = probe(render(React.createElement(CircleRing, { ring, pot: 6n * U, round: 1 })), width);
      assert.match(out.fig, /CircleRing_stLogo/, "precondition: the first frame is the logo stage");
      assert.deepEqual(out.shown, [], `the logo carries "no labels at all (no seat words, numbers, ... pot text)", but the first frame paints the caption: ${out.shown.join("; ")}`);
    });
  }
});
