/**
 * Adversary, A10 404 tapes (Joshua, 2026-10-09: "the ribbon doesnt go to the end in the 404 page, it should be under
 * the sidebar and go to the end"), against b212ead. The spec as briefed: the two tapes span the full window width, left
 * edge to right edge, passing UNDER the sidebar rail (the rail stays on top), at every viewport width, with no
 * horizontal page scroll and nothing else (copy, buttons, the phone nav pill) covered.
 *
 * tests/a10-404-tapes.spec.ts pins the CSS text only. Two regressions it does not see, each checked by hand against a
 * running build of b212ead: a `z-index` on .tape (the child, not .tapes) lifts the tapes over the rail, and a later
 * `.tapes { margin-left: 0 }` rule stops them at the rail gutter again. This spec measures the rendered page instead.
 * It passes on b212ead. The tapes ignore the pointer (pointer-events: none), so for the stacking checks the spec turns
 * hit-testing back on for them first; that changes nothing that is painted.
 *
 * Needs a running production server of the build under test, and a Chromium: $CHROME, else Playwright's cached
 * chrome-headless-shell (under WSL, LD_LIBRARY_PATH may need its libs).
 *
 *   A10_URL=http://127.0.0.1:3947 npx mocha --import=tsx --timeout 300000 tests/a10-404-tapes-render-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const WIDTHS = [320, 400, 759, 760, 1000, 1001, 1280, 1920, 2560];
const HEIGHTS = [900, 500];

function chromeBin(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const d of existsSync(cache) ? readdirSync(cache) : []) {
    const bin = join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (d.startsWith("chromium_headless_shell") && existsSync(bin)) return bin;
  }
  throw new Error("no Chromium: set CHROME, or install Playwright's chrome-headless-shell");
}

function stop(p: ChildProcess | undefined): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return new Promise((r) => { p.once("exit", () => r()); p.kill("SIGTERM"); });
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: unknown };
class Cdp {
  private next = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private listeners: ((m: Message) => void)[] = [];
  session: string | undefined;
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Message;
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (p) { this.pending.delete(m.id!); if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result); }
      else for (const l of [...this.listeners]) l(m);
    });
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, browser = false): Promise<T> {
    const id = ++this.next;
    return new Promise((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(browser ? {} : { sessionId: this.session }) }));
    });
  }
  once(method: string): Promise<Message> {
    return new Promise((r) => {
      const l = (m: Message) => { if (m.method === method && m.sessionId === this.session) { this.listeners.splice(this.listeners.indexOf(l), 1); r(m); } };
      this.listeners.push(l);
    });
  }
  async goto(url: string): Promise<void> {
    const loaded = this.once("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  }
}

type Measure = {
  iw: number; sw: number; phone: boolean;
  tapesLeft: number; tapesRight: number;
  railOverTapes: boolean | null;
  buttonsClear: [string, boolean][];
  inkBottom: number; pillTop: number;
};

/** Measured in the page, scrolled to the bottom so the tapes are in view. */
const MEASURE = `(async () => {
  window.scrollTo(0, 1e6);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tapes = document.querySelector('[class*="NotFound_tapes"]');
  const rail = document.querySelector('aside[class*="Shell_rail"]');
  if (!tapes || !rail) throw new Error("no tapes or no rail on the page");
  const phone = matchMedia('(max-width: 759px)').matches;
  tapes.style.pointerEvents = 'auto';
  const tr = tapes.getBoundingClientRect(), rr = rail.getBoundingClientRect();
  let railOverTapes = null;
  if (!phone) {
    const y = Math.min(rr.bottom - 30, tr.top + tr.height / 2);
    if (y > tr.top && y < tr.bottom) railOverTapes = rail.contains(document.elementFromPoint(rr.left + rr.width / 2, y));
  }
  const buttonsClear = [...document.querySelectorAll('a')].filter((a) => /^(Go home|Create a circle)$/.test(a.textContent.trim())).map((a) => {
    a.scrollIntoView({ block: 'center' });
    const r = a.getBoundingClientRect();
    // the buttons are pills (border-radius 999px), so sample inside the pill: its middle line and the top and bottom edges at the centre
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pts = [[r.left + r.height / 2, cy], [cx, cy], [r.right - r.height / 2, cy], [cx, r.top + 4], [cx, r.bottom - 4]];
    return [a.textContent.trim(), pts.every(([x, y]) => a.contains(document.elementFromPoint(x, y)))];
  });
  window.scrollTo(0, 1e6);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  tapes.style.pointerEvents = '';
  const ink = [...tapes.children].map((t) => t.getBoundingClientRect().bottom);
  return { iw: innerWidth, sw: document.documentElement.scrollWidth, phone, tapesLeft: tr.left, tapesRight: tr.right, railOverTapes, buttonsClear,
    inkBottom: Math.max(...ink), pillTop: rail.getBoundingClientRect().top };
})()`;

async function measureAll(url: string): Promise<{ w: number; h: number; m: Measure }[]> {
  const profile = mkdtempSync(join(tmpdir(), "a10-tapes-"));
  const chrome = spawn(chromeBin(), ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let ws: WebSocket | undefined;
  try {
    const wsUrl = await new Promise<string>((res, rej) => {
      let err = "";
      chrome.stderr!.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res(m[1]!); });
      chrome.once("exit", (c) => rej(new Error(`chrome exited ${c}: ${err}`)));
    });
    ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws!.addEventListener("open", r); ws!.addEventListener("error", j); });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, true);
    cdp.session = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, true)).sessionId;
    await cdp.send("Page.enable");
    const out: { w: number; h: number; m: Measure }[] = [];
    for (const w of WIDTHS) for (const h of HEIGHTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await cdp.goto(`${url}/this-does-not-exist`);
      await cdp.evaluate("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400)))");
      out.push({ w, h, m: await cdp.evaluate<Measure>(MEASURE) });
    }
    return out;
  } finally {
    ws?.close();
    await stop(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("A10 adversary: the rendered 404 tapes", () => {
  let runs: { w: number; h: number; m: Measure }[] = [];
  before(async function () {
    const url = process.env.A10_URL;
    if (!url) this.skip();
    runs = await measureAll(url.replace(/\/$/, ""));
  });

  it("run from the window's left edge to its right edge, with no horizontal scroll", () => {
    for (const { w, h, m } of runs) {
      assert.ok(Math.abs(m.tapesLeft) < 0.5 && Math.abs(m.tapesRight - m.iw) < 0.5, `${w}x${h}: tapes span ${m.tapesLeft}..${m.tapesRight}, window is 0..${m.iw}`);
      assert.ok(m.sw <= m.iw, `${w}x${h}: horizontal scroll, scrollWidth ${m.sw} > innerWidth ${m.iw}`);
    }
  });

  it("desktop: the rail stays on top where it crosses the tapes", () => {
    const checked = runs.filter((r) => r.m.railOverTapes !== null);
    assert.ok(checked.length > 0, "no desktop viewport put the rail over the tapes, so nothing was checked");
    for (const { w, h, m } of checked) assert.equal(m.railOverTapes, true, `${w}x${h}: the tapes paint over the rail`);
  });

  it("cover neither button, and stay above the phone nav pill", () => {
    for (const { w, h, m } of runs) {
      assert.equal(m.buttonsClear.length, 2, `${w}x${h}: expected Go home and Create a circle`);
      for (const [name, clear] of m.buttonsClear) assert.ok(clear, `${w}x${h}: something covers "${name}"`);
      if (m.phone) assert.ok(m.inkBottom <= m.pillTop, `${w}x${h}: the tapes reach ${m.inkBottom}, the nav pill starts at ${m.pillTop}`);
    }
  });
});
