/**
 * Adversary, A5 ring in the logo's style (Joshua, 2026-10-05), pass on 10bead6. The spec: "coloured seat discs inside
 * a white ring with a black gap, joined by arcs in each seat's colour ... the pot as the lime centre disc in the same
 * rings. It must work for 3 to 8 seats: arcs never run under a seat disc, seats never overlap each other or the pot
 * ... in every palette the site offers (the hero background is the palette's accent)."
 *
 * The real components/robinhood/CircleRing.tsx is rendered with react-dom/server (the app's own React) from a ring
 * built by the repo's own ringOf (lib/robinhood/circle-view.ts) over a constructed read: n=3, Active, round 0, so
 * Seat 1 receives at the top and the ring is not turned. The markup sits in the page's real hero section (the
 * Circle.module.css .hero and Robinhood.module.css .ringHero classes, as RobinhoodCircle.tsx uses them), styled by
 * globals.css, those modules and CircleRing.module.css (each module's classes kept apart by a per-module prefix, as
 * CSS modules do), with every palette's variables from lib/theme.ts themeVars, light and dark. A real Chromium lays it
 * out (and, for the colour check, screenshots it). Browser: $CHROME, else Playwright's cached chrome-headless-shell, else
 * Windows Chrome under WSL.
 * No network: the document is a local file; the font falls back to the stylesheets' own fallbacks.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-ring-logo-adversary.spec.ts
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
import { inflateSync } from "node:zlib";

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
const seat = (turn: number): RhSeat => ({ turn, wallet: W(turn), collateral: 10n * U, g: U, topUps: 0n, forfeited: 0n, allocated: 0n,
  lastCoverageBps: 0, delinquentMarks: 0, roundsPaid: 0, joined: true, paid: false, received: false, defaulted: false, marked: false, withdrawn: false });
const read: RhCircleView = {
  address: W(9), factory: W(8), creator: W(0), n: 3, c: 2n * U, g: U, minStockCover: 10n * U, haircutBps: 1000, coverageBps: 10000, warnBps: 0,
  roundSecs: 86_400, graceSecs: 3_600, status: "Active", round: 0, deadline: 2_000_000, reserveTotal: 0n, reserveLosses: 0n, reserveAllocated: 0n,
  escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n, collateralReturned: 0n, depositsTotal: 0n, forfeitedTotal: 0n, nextGateShortBy: 0n,
  heldContributions: 0n, lastCoverageAt: 0, balance: 0n, surplus: 0n, seats: [seat(0), seat(1), seat(2)], readAt: 1_000_000, chainTime: 1_000_000, block: 1,
};

async function ringMarkup(): Promise<string> {
  const React = appRequire("react");
  g.React = React;
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const mod = await import(pathToFileURL(RING).href);
  const ring = ringOf(read, null);
  assert.equal(ring.receiving, 0, "precondition: Seat 1 receives, at the top");
  assert.equal(ring.rotation, 0, "precondition: the ring is not turned");
  return renderToStaticMarkup(React.createElement(mod.default, { entrance: false, ring, pot: 6n * U, round: 0 }));
}

function scoped(mod: string, css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\.([a-zA-Z_][\w-]*)/g, `.${mod}_$1`);
}

/** Browsers: $CHROME, Playwright's cached chrome-headless-shell, then Windows Chrome under WSL. */
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

function fileUrl(path: string, windows: boolean): string {
  return windows ? "file:" + forBrowser(path, true).replace(/\\/g, "/") : pathToFileURL(path).href;
}

/** The page: the hero section as RobinhoodCircle.tsx renders it, at `width` px, in one palette's colours. */
function page(markup: string, vars: Record<string, string>, width: number, probe: string, extra = ""): string {
  const css = ":root { --font-jakarta: 'Plus Jakarta Sans'; --font-archivo: Archivo; " +
    Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(" ") + " }\n" +
    readFileSync(resolve(SRC, "app/globals.css"), "utf8") + "\n" +
    Object.entries(CSS_FILES).map(([m, f]) => scoped(m, readFileSync(f, "utf8"))).join("\n") +
    "\nbody { margin: 0; padding: 16px; } .Circle_hero { box-shadow: none; }\n" + extra;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}"><style>${css}</style></head>` +
    `<body style="width:${width - 32}px"><section class="Circle_hero Robinhood_ringHero">${markup}<div class="Circle_heroMain"></div></section>` +
    `<script>${probe}</script></body></html>`;
}

function chrome(html: string, args: string[], width: number): { stdout: string; png: Buffer | null } {
  const errors: string[] = [];
  for (const b of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a5-ring-"));
    try {
      const file = join(dir, "ring.html");
      writeFileSync(file, html);
      const shot = join(dir, "shot.png");
      const r = spawnSync(b.bin, [b.windows ? "--headless=new" : "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
        "--no-first-run", "--disable-extensions", "--force-device-scale-factor=1",
        `--user-data-dir=${forBrowser(join(dir, "profile"), b.windows)}`, `--window-size=${width},1400`, "--virtual-time-budget=3000",
        ...args.map((a) => a.replace("%SHOT%", forBrowser(shot, b.windows))), fileUrl(file, b.windows)], { encoding: "utf8", timeout: 90_000 });
      const png = existsSync(shot) ? readFileSync(shot) : null;
      if ((r.stdout ?? "").includes("ring-out") || png) return { stdout: r.stdout ?? "", png };
      errors.push(`${b.bin} (status ${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`no Chromium ran; set CHROME to a chrome or chrome-headless-shell binary.\n${errors.join("\n")}`);
}

/** A PNG's pixels (8-bit RGB or RGBA, not interlaced, as Chromium writes screenshots). */
function decodePng(buf: Buffer): { w: number; h: number; px: (x: number, y: number) => [number, number, number] } {
  let pos = 8;
  let w = 0, h = 0, type = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]!;
      assert.equal(data[8], 8, "8-bit PNG"); assert.equal(data[12], 0, "not interlaced");
    }
    if (kind === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + i] = (x + pred) & 255;
    }
  }
  return { w, h, px: (x, y) => { const o = Math.round(y) * stride + Math.round(x) * bpp; return [out[o]!, out[o + 1]!, out[o + 2]!]; } };
}

const PROBE = `
  const ring = document.querySelector('.CircleRing_ring').getBoundingClientRect();
  const c = (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, r: el.offsetWidth / 2,
    rings: getComputedStyle(el).boxShadow.split(/,(?![^(]*\\))/).map((s) => parseFloat(s.trim().split(' ').pop())) }; };
  const seats = [...document.querySelectorAll('.CircleRing_seat')].map(c);
  const pot = c(document.querySelector('.CircleRing_pot'));
  const out = { ring: { left: ring.left, top: ring.top, width: ring.width }, seats, pot };
  const pre = document.createElement('pre'); pre.id = 'ring-out'; pre.textContent = JSON.stringify(out); document.body.appendChild(pre);`;
type Disc = { x: number; y: number; r: number; rings: number[] };
type Layout = { ring: { left: number; top: number; width: number }; seats: Disc[]; pot: Disc };

function layout(markup: string, vars: Record<string, string>, width: number): Layout {
  const { stdout } = chrome(page(markup, vars, width, PROBE), ["--dump-dom"], width);
  const json = /<pre id="ring-out">([^<]*)<\/pre>/.exec(stdout)?.[1];
  assert.ok(json, "the probe reported the ring's layout");
  return JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Layout;
}

const PALETTE_VARS = PALETTES.flatMap((p) => [false, true].map((dark) => ({ name: `${p.name} ${dark ? "dark" : "light"}`, vars: themeVars(p, dark) })));
const DESKTOP = 1280;
const PHONE = 360;

describe("A5 adversary (10bead6): the ring in the logo's style, laid out and painted by Chromium", () => {
  let markup = "";
  before(async () => { markup = await ringMarkup(); });

  // n=3, unturned: seat k at k*120 degrees clockwise from the top; seat k's arc runs to seat k+1, its middle at
  // k*120 + 60 degrees on the seats' circle. Each arc's cross-section there against the hero just inside it.
  type Arc = { seat: number; ground: number[]; stroke: number[]; diff: number };
  const diff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  function arcs(vars: Record<string, string>, extra = ""): Arc[] {
    const l = layout(markup, vars, DESKTOP);
    const { png } = chrome(page(markup, vars, DESKTOP, "", extra), ["--screenshot=%SHOT%"], DESKTOP);
    assert.ok(png, "Chromium wrote a screenshot");
    const img = decodePng(png);
    assert.equal(img.w, DESKTOP, "precondition: the screenshot is one pixel per CSS px");
    const cx = l.ring.left + l.ring.width / 2, cy = l.ring.top + l.ring.width / 2;
    // the seats' circle radius, measured: the distance from the ring's centre to a seat's centre
    const R = Math.hypot(l.seats[1]!.x - cx, l.seats[1]!.y - cy);
    const at = (deg: number, rad: number) => img.px(cx + rad * Math.sin((deg * Math.PI) / 180), cy - rad * Math.cos((deg * Math.PI) / 180));
    const report = [0, 1, 2].map((k) => {
      const mid = k * 120 + 60;
      const ground = at(mid, R - l.ring.width * 0.05);
      // the whole cross-section of the arc, so an arc made visible by an outline or casing counts as visible
      let best = { stroke: at(mid, R), diff: diff(at(mid, R), ground) };
      for (let o = -Math.ceil(l.ring.width * 0.02); o <= Math.ceil(l.ring.width * 0.02); o++) {
        const p = at(mid, R + o);
        if (diff(p, ground) > best.diff) best = { stroke: p, diff: diff(p, ground) };
      }
      return { seat: k + 1, ground, ...best };
    });
    assert.ok(report.every((x) => diff(x.ground, report[0]!.ground) <= 2), `precondition: one hero colour around the ring: ${JSON.stringify(report)}`);
    return report;
  }
  const show = (report: Arc[]) => report.map((x) => `Seat ${x.seat}: rgb(${x.stroke.join(",")}) on rgb(${x.ground.join(",")})`).join("; ");

  it("control: on a white ground instead of the hero's accent, the same sampling finds all three arcs, Seat 2's included", () => {
    const report = arcs(PALETTE_VARS[0]!.vars, ".Circle_hero { background: #FFFFFF; }");
    assert.ok(report.every((x) => x.diff > 24), `control: ${show(report)}`);
  });

  for (const { name, vars } of PALETTE_VARS) {
    it(`${name}: every seat's arc is visible against the hero (Seat 2's arc included)`, () => {
      const report = arcs(vars);
      for (const x of report) {
        assert.ok(x.diff > 24,
          `${name}: across its whole width Seat ${x.seat}'s arc differs from the hero by at most ${x.diff} in any channel ` +
            `(rgb(${x.stroke.join(",")}) on rgb(${x.ground.join(",")})): the arc joining Seat ${x.seat} to the next seat cannot be seen [${show(report)}]`);
      }
    });
  }

  for (const width of [DESKTOP, PHONE]) {
    it(`${width}px wide, 3 seats: no seat's disc and its white ring overlaps the pot's, nor another seat's`, () => {
      const l = layout(markup, PALETTE_VARS[0]!.vars, width);
      assert.equal(l.seats.length, 3, "precondition: three seats");
      // each disc as the logo draws it: the disc, then its white ring and the black line around it (the first two
      // box-shadow rings: 0 0 0 3px #FBF9F2, 0 0 0 5px #0B0B0B on a seat and the pot; 4px and 6px on the receiving seat)
      const extent = (d: Disc) => d.r + (d.rings[1] ?? d.rings[0] ?? 0);
      const clash: string[] = [];
      l.seats.forEach((s, i) => {
        const toPot = Math.hypot(s.x - l.pot.x, s.y - l.pot.y);
        const overlap = extent(s) + extent(l.pot) - toPot;
        if (overlap > 0.5) clash.push(`Seat ${i + 1}${i === 0 ? " (receiving)" : ""} and the pot overlap by ${overlap.toFixed(1)}px ` +
          `(centres ${toPot.toFixed(1)}px apart, seat ${s.r.toFixed(1)}+${extent(s) - s.r}px, pot ${l.pot.r.toFixed(1)}+${extent(l.pot) - l.pot.r}px)`);
        l.seats.slice(i + 1).forEach((t, j) => {
          const d = Math.hypot(s.x - t.x, s.y - t.y);
          if (extent(s) + extent(t) - d > 0.5) clash.push(`Seat ${i + 1} and Seat ${i + j + 2} overlap by ${(extent(s) + extent(t) - d).toFixed(1)}px`);
        });
      });
      assert.deepEqual(clash, [], `ring ${l.ring.width.toFixed(0)}px wide at a ${width}px screen: ${clash.join("; ")}`);
    });
  }
});

/**
 * Adversary pass on 6c5b505 (seat colours, cleaner edges, seats shrink from five). Spec (product owner, 2026-10-05):
 * "seats and pot are smooth circles with solid black borders, arcs have tidy ends and stop short of the seats
 * (including the larger receiving seat)" (2); "from 5 members they shrink ... for 5, 6, 7 and 8 seats, on desktop and
 * at phone width (360px+); labels ("Seat N", "You") stay readable inside each seat at every size" (3).
 * The ring is built by ringOf over a constructed Active read of n seats, round 0 (Seat 1 receives at the top, the ring
 * is not turned), the viewer holding the last seat, so that seat carries its "You" label as the page draws it.
 */
const GEOMETRY = `
  const ring = document.querySelector('.CircleRing_ring').getBoundingClientRect();
  const seats = [...document.querySelectorAll('.CircleRing_seat')].map((el) => {
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const label = el.querySelector('.CircleRing_upright').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: el.offsetWidth, h: el.offsetHeight, border: parseFloat(cs.borderTopWidth),
      halo: Math.max(0, ...cs.boxShadow.split(/,(?![^(]*\\))/).map((s) => parseFloat(s.trim().split(' ').pop()) || 0)),
      label: { w: label.width, h: label.height }, you: !!el.querySelector('.CircleRing_you') };
  });
  const arcs = [...document.querySelectorAll('.CircleRing_arcs path')].map((p) => {
    const m = p.getScreenCTM(), L = p.getTotalLength();
    const at = (s) => { const q = p.getPointAtLength(s); return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f }; };
    return { a: at(0), b: at(L), half: (parseFloat(p.getAttribute('stroke-width')) * m.a) / 2, cap: p.getAttribute('stroke-linecap') };
  });
  const pre = document.createElement('pre'); pre.id = 'ring-out';
  pre.textContent = JSON.stringify({ ring: { width: ring.width }, seats, arcs }); document.body.appendChild(pre);`;
type GSeat = { x: number; y: number; w: number; h: number; border: number; halo: number; label: { w: number; h: number }; you: boolean };
type GArc = { a: { x: number; y: number }; b: { x: number; y: number }; half: number; cap: string };

describe("A5 adversary (6c5b505): seats stay circles holding their labels, and arcs stop short of them, 3 to 8 seats", () => {
  const sized: Record<number, string> = {};
  before(async () => {
    const React = appRequire("react");
    g.React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const mod = await import(pathToFileURL(RING).href);
    for (let n = 3; n <= 8; n++) {
      const v: RhCircleView = { ...read, n, seats: Array.from({ length: n }, (_, t) => seat(t)) };
      const ring = ringOf(v, W(n - 1));
      assert.equal(ring.receiving, 0, "precondition: Seat 1 receives");
      assert.ok(ring.seats[n - 1]!.you, "precondition: the viewer holds the last seat");
      sized[n] = renderToStaticMarkup(React.createElement(mod.default, { entrance: false, ring, pot: BigInt(n) * 2n * U, round: 0 }));
    }
  });
  function geometry(n: number, width: number): { ring: { width: number }; seats: GSeat[]; arcs: GArc[] } {
    const { stdout } = chrome(page(sized[n]!, PALETTE_VARS[0]!.vars, width, GEOMETRY), ["--dump-dom"], width);
    const json = /<pre id="ring-out">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(json, "the probe reported the ring's geometry");
    const out = JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    assert.equal(out.seats.length, n, `precondition: ${n} seats drawn`);
    assert.ok(out.seats[n - 1].you, "precondition: the last seat carries its You label");
    assert.equal(out.arcs.length, 2 * n, `precondition: ${n} arcs, each a black casing and a colour`);
    return out;
  }

  for (const width of [DESKTOP, PHONE]) {
    for (let n = 3; n <= 8; n++) {
      it(`${width}px, ${n} seats: every seat is a circle (as tall as it is wide) whose "Seat N" and "You" fit inside its black border`, () => {
        const l = geometry(n, width);
        const bad: string[] = [];
        l.seats.forEach((s, i) => {
          const inner = s.w - 2 * s.border;
          if (Math.abs(s.h - s.w) > 0.5 || s.label.h > inner + 0.5) {
            bad.push(`Seat ${i + 1}${s.you ? " (You)" : ""} is ${s.w}px wide and ${s.h}px tall; its label stack is ` +
              `${s.label.h.toFixed(1)}px tall inside ${inner}px within the border`);
          }
        });
        assert.deepEqual(bad, [], `ring ${l.ring.width.toFixed(0)}px wide at ${width}px: ${bad.join("; ")}`);
      });

      it(`${width}px, ${n} seats: every arc's drawn end, round cap included, stops short of the seats it joins, the receiving seat's ring included`, () => {
        const l = geometry(n, width);
        const bad: string[] = [];
        l.arcs.forEach((arc, i) => {
          const k = Math.floor(i / 2);
          for (const { p, s } of [{ p: arc.a, s: k }, { p: arc.b, s: (k + 1) % n }]) {
            const at = l.seats[s]!;
            const reach = arc.cap === "butt" ? 0 : arc.half; // a round or square cap paints half the stroke's width past the end
            const gap = Math.hypot(p.x - at.x, p.y - at.y) - reach - (at.w / 2 + at.halo);
            // half a pixel of anti-aliasing allowed
            if (gap < -0.5) bad.push(`Seat ${k + 1}'s arc (${i % 2 ? "colour" : "black casing"}, ${arc.cap} cap, ${(2 * arc.half).toFixed(1)}px wide) ` +
              `runs ${(-gap).toFixed(1)}px into Seat ${s + 1} (disc ${at.w}px across, ${at.halo}px ring around it)`);
          }
        });
        assert.deepEqual(bad, [], `ring ${l.ring.width.toFixed(0)}px wide at ${width}px: ${bad.join("; ")}`);
      });
    }
  }
});
