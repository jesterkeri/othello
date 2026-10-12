/**
 * Adversary, A10 404 tapes, against 9d88a57 (Joshua, 2026-10-09: "the ribbon doesnt go to the end in the 404 page, it
 * should be under the sidebar and go to the end"). The spec as briefed: the moving text on each tape always fills the
 * tape to both window edges at every moment of the roll, at any width, very wide and zoomed-out windows included.
 *
 * 9d88a57 sizes the strip once after mount (and again on resize only) from the strip's measured width. The tape text is
 * Archivo at font-stretch 70%, served with font-display: swap, so until the woff2 files arrive the strip is laid out in
 * the Arial fallback, which has no condensed face and is wider. When the page hydrates before the fonts land (a slow or
 * lossy first visit; nothing is cached yet), the strip is sized on fallback metrics, Archivo then swaps in and every
 * round shrinks, and nothing measures again: no resize happens, so the strip stays too short until the window is
 * resized. tests/a10-404-tapes-fill-adversary.spec.ts waits for document.fonts.ready before it looks, and the font is
 * already there at mount, so it cannot see this.
 *
 * This spec holds every /fonts/*.woff2 request (CDP Fetch) until React has hydrated the 404 page and its effect has
 * run, then lets them through, waits for document.fonts.ready, freezes each track at the start, quarter and end of its
 * roll, and hit-tests the tape's centre line one pixel inside the window's right edge. 5120 is a 2560px screen at 50%
 * browser zoom, 6000 a little wider.
 *
 * Needs a running production server of the build under test, and a Chromium: $CHROME, else Playwright's cached
 * chrome-headless-shell (under WSL, LD_LIBRARY_PATH may need its libs).
 *
 *   A10_URL=http://127.0.0.1:3977 npx mocha --import=tsx --timeout 300000 tests/a10-404-tapes-fontload-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const WIDTHS = [5120, 6000];
const ROLL = [0, 25, 50];

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: unknown };
class Cdp {
  private next = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  listeners: ((m: Message) => void)[] = [];
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
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  }
}

/** True once React has hydrated tape A's track (its fiber key is on the node) and two frames have passed for the effect. */
const HYDRATED = `(async () => {
  const t = document.querySelector('[class*="NotFound_tapes"]');
  const a = t && t.children[0] && t.children[0].firstElementChild;
  if (!a || !Object.keys(a).some((k) => k.startsWith('__reactFiber'))) return false;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 300));
  return true;
})()`;

type Probe = { tape: "A" | "B"; roll: number; strip: number; right: string };

const PROBE = `(async () => {
  window.scrollTo(0, 1e6);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tapes = document.querySelector('[class*="NotFound_tapes"]');
  tapes.style.pointerEvents = 'auto';
  const all = [...tapes.children];
  const out = [];
  all.forEach((tape, n) => {
    const track = tape.firstElementChild;
    for (const other of all) other.style.visibility = other === tape ? '' : 'hidden';
    for (const roll of ${JSON.stringify(ROLL)}) {
      track.style.animation = 'none';
      track.style.transform = 'translateX(-' + roll + '%)';
      const r = tape.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const m = new DOMMatrix(getComputedStyle(tape).transform), slope = m.b / m.a;
      const x = innerWidth - 1, e = document.elementFromPoint(x, cy + (x - cx) * slope);
      const right = e && track.contains(e) ? 'text' : e === tape ? 'bare tape' : e ? e.tagName + '.' + e.className : 'nothing';
      out.push({ tape: n === 0 ? 'A' : 'B', roll, strip: track.scrollWidth / 2, right });
    }
    track.style.animation = ''; track.style.transform = '';
  });
  for (const t of all) t.style.visibility = '';
  tapes.style.pointerEvents = '';
  return out;
})()`;

type Run = { w: number; roundsBeforeFont: string; roundsAfterFont: string; held: number; p: Probe[] };

async function probeAll(url: string): Promise<Run[]> {
  const profile = mkdtempSync(join(tmpdir(), "a10-fontload-"));
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
    const out: Run[] = [];
    for (const w of WIDTHS) {
      // A fresh target per width, with the cache off, so every width loads the fonts over the (held) network.
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, true);
      cdp.session = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, true)).sessionId;
      await cdp.send("Page.enable");
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      const held: string[] = [];
      const session = cdp.session;
      const hold = (m: Message) => { if (m.method === "Fetch.requestPaused" && m.sessionId === session) held.push(String(m.params!.requestId)); };
      cdp.listeners.push(hold);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/fonts/*.woff2", requestStage: "Request" }] });
      await cdp.send("Page.navigate", { url: `${url}/this-does-not-exist` });
      let hydrated = false;
      for (let i = 0; i < 100 && !hydrated; i++) { hydrated = await cdp.evaluate<boolean>(HYDRATED).catch(() => false); if (!hydrated) await sleep(100); }
      assert.ok(hydrated, `${w}px: the 404 page never hydrated`);
      const rounds = `document.querySelector('[class*="NotFound_tapes"]').children[0].firstElementChild.style.getPropertyValue('--rounds')`;
      const roundsBeforeFont = await cdp.evaluate<string>(rounds);
      const fontsWaiting = held.length;
      // Let the fonts through, and any that are requested later.
      cdp.listeners.splice(cdp.listeners.indexOf(hold), 1);
      const pass = (m: Message) => { if (m.method === "Fetch.requestPaused" && m.sessionId === session) void cdp.send("Fetch.continueRequest", { requestId: m.params!.requestId }); };
      cdp.listeners.push(pass);
      for (const requestId of held) await cdp.send("Fetch.continueRequest", { requestId });
      await cdp.evaluate("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 600)))");
      const roundsAfterFont = await cdp.evaluate<string>(rounds);
      out.push({ w, roundsBeforeFont, roundsAfterFont, held: fontsWaiting, p: await cdp.evaluate<Probe[]>(PROBE) });
      cdp.listeners.splice(cdp.listeners.indexOf(pass), 1);
      await cdp.send("Target.closeTarget", { targetId }, true);
    }
    return out;
  } finally {
    ws?.close();
    await stop(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("A10 adversary: the 404 tape text still reaches the right edge when Archivo arrives after hydration", () => {
  let runs: Run[] = [];
  before(async function () {
    const url = process.env.A10_URL;
    if (!url) this.skip();
    runs = await probeAll(url.replace(/\/$/, ""));
  });

  it("held the font files until the page had hydrated", () => {
    assert.equal(runs.length, WIDTHS.length);
    for (const r of runs) assert.ok(r.held > 0, `${r.w}px: no font request was held, so the test proves nothing`);
  });

  it("no bare tape at the window's right edge once the font has swapped in", () => {
    for (const { w, roundsBeforeFont, roundsAfterFont, p } of runs) for (const r of p) {
      assert.equal(r.right, "text",
        `${w}px, tape ${r.tape} at translateX(-${r.roll}%): right edge shows ${r.right}; strip ${r.strip}px, needs ${1.45 * w}px; ` +
        `--rounds ${roundsBeforeFont} sized before the font, ${roundsAfterFont} after`);
    }
  });
});
