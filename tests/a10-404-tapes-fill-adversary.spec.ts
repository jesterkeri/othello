/**
 * Adversary, A10 404 tapes, against 6edbd57 (Joshua, 2026-10-09: "the ribbon doesnt go to the end in the 404 page, it
 * should be under the sidebar and go to the end"). The spec as briefed: on the 404 page the moving text on each tape
 * always fills the tape to the right window edge, at every width, with no bare stretch of tape at any moment of the
 * roll.
 *
 * Neither tests/a10-404-tapes.spec.ts (CSS text) nor tests/a10-404-tapes-render-adversary.spec.ts (tape box, rail,
 * buttons) looks at the text inside a tape, so putting the strip back to 4 rounds passes both. This spec freezes each
 * track at the start, the quarter and the end of its roll (translateX 0, -25%, -50%: `roll` runs 0 to -50%, `rollBack`
 * -50% to 0, so these are both ends of both tracks) and hit-tests the tape's centre line one pixel inside the window's
 * left and right edges. The other tape is hidden while one is checked: the two cross, and at phone widths tape B lies
 * over tape A near the edges by design. The tapes ignore the pointer, so hit-testing is turned back on for them first;
 * that changes nothing that is painted.
 *
 * Widths above about 4,050px fail on 6edbd57: one strip is 5,876.5px at the 18px font, the tape starts 45% of the window
 * left of it, so at the end of the roll the text stops at -0.45 * W + 5,876.5 and bare tape shows to the right of that.
 * 5120 is a 2560px screen at 50% browser zoom.
 *
 * Needs a running production server of the build under test, and a Chromium: $CHROME, else Playwright's cached
 * chrome-headless-shell (under WSL, LD_LIBRARY_PATH may need its libs).
 *
 *   A10_URL=http://127.0.0.1:3961 npx mocha --import=tsx --timeout 300000 tests/a10-404-tapes-fill-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// 4559, 5572, 7092 and 8105 showed bare tape on a build without NotFound.tsx's spare round (adversary on 6724b33)
const WIDTHS = [320, 760, 1280, 1920, 2560, 3840, 4096, 4559, 5120, 5572, 7092, 8105];
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

/** One row per tape and roll position: what is under the tape's centre line at x = 1 and x = innerWidth - 1. */
type Probe = { tape: "A" | "B"; roll: number; strip: number; left: string; right: string };

const PROBE = `(async () => {
  window.scrollTo(0, 1e6);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tapes = document.querySelector('[class*="NotFound_tapes"]');
  if (!tapes) throw new Error("no tapes on the page");
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
      const at = (x) => {
        const e = document.elementFromPoint(x, cy + (x - cx) * slope);
        return e && track.contains(e) ? 'text' : e === tape ? 'bare tape' : e ? e.tagName + '.' + e.className : 'nothing';
      };
      out.push({ tape: n === 0 ? 'A' : 'B', roll, strip: track.scrollWidth / 2, left: at(1), right: at(innerWidth - 1) });
    }
    track.style.animation = ''; track.style.transform = '';
  });
  for (const t of all) t.style.visibility = '';
  tapes.style.pointerEvents = '';
  return out;
})()`;

async function probeAll(url: string): Promise<{ w: number; p: Probe[] }[]> {
  const profile = mkdtempSync(join(tmpdir(), "a10-fill-"));
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
    const out: { w: number; p: Probe[] }[] = [];
    for (const w of WIDTHS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.goto(`${url}/this-does-not-exist`);
      await cdp.evaluate("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400)))");
      out.push({ w, p: await cdp.evaluate<Probe[]>(PROBE) });
    }
    return out;
  } finally {
    ws?.close();
    await stop(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("A10 adversary: the 404 tape text reaches both window edges at every point of the roll", () => {
  let runs: { w: number; p: Probe[] }[] = [];
  before(async function () {
    const url = process.env.A10_URL;
    if (!url) this.skip();
    runs = await probeAll(url.replace(/\/$/, ""));
  });

  it("probed both tapes at every width and roll position", () => {
    assert.equal(runs.length, WIDTHS.length);
    for (const { w, p } of runs) assert.equal(p.length, 2 * ROLL.length, `${w}px: expected two tapes`);
  });

  it("no bare tape at the window's left edge", () => {
    for (const { w, p } of runs) for (const r of p) assert.equal(r.left, "text", `${w}px, tape ${r.tape} at translateX(-${r.roll}%): left edge shows ${r.left}`);
  });

  it("no bare tape at the window's right edge", () => {
    for (const { w, p } of runs) for (const r of p) {
      assert.equal(r.right, "text", `${w}px, tape ${r.tape} at translateX(-${r.roll}%), strip ${r.strip}px: right edge shows ${r.right}`);
    }
  });
});
