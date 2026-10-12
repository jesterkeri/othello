/**
 * Adversary, A10 404 tapes, against 9f6b59c (Joshua, 2026-10-09: "the ribbon doesnt go to the end in the 404 page, it
 * should be under the sidebar and go to the end"). The spec as briefed: at any width, with the web font loaded or never
 * loading, the 404 page has no render loop, oscillation or runaway re-renders.
 *
 * 9f6b59c measures the strip as parseFloat(getComputedStyle(track).width) / 2 instead of scrollWidth / 2, so that
 * strip / rounds is the same at every rounds and the rule rounds = max(8, ceil(1.45 * innerWidth / perRound) + 1)
 * settles. But Chromium serializes a computed length to 6 significant digits: tape A's track at 9 rounds is
 * 13221.5625px in layout and reads "13221.6px", and once the track is 100,000px or more (69 rounds in Archivo, 53 in
 * the fallback) it reads whole pixels, which is the scrollWidth rounding the commit set out to remove. perRound again
 * differs slightly with rounds, and where 1.45 * innerWidth sits within that difference of a whole number of rounds,
 * rounds flips between N and N + 1 for as long as the page is open.
 *
 * Same method as tests/a10-404-tapes-settle-adversary.spec.ts, with the component's new measurement: on a 1440px window
 * it clones tape A's track at 8 to 200 rounds and reads each clone's computed width, runs the component's rule from 8
 * for every width from 3,500 to 90,000px, keeps the widths where it never settles, then opens each and counts --rounds
 * changes in the second after a 1.5 s settle, fonts served and fonts failed. On this machine's chrome-headless-shell
 * the widths were 52,177 and 75,986px (Archivo) and 48,435, 64,798 and 85,743px (fallback); none below 48,000px. These
 * are more extreme than the scrollWidth ones (48,435px is a 12,109 device-pixel window at Chromium's lowest zoom, 25%),
 * so this is a correctness hole in the "every width" claim more than a likely sighting.
 *
 * Needs a running production server of the build under test, and a Chromium: $CHROME, else Playwright's cached
 * chrome-headless-shell (under WSL, LD_LIBRARY_PATH may need its libs).
 *
 *   A10_URL=http://127.0.0.1:3987 npx mocha --import=tsx --timeout 600000 tests/a10-404-tapes-settle-wide-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SEARCH = { from: 3500, to: 90000 };
const ROUNDS = { min: 8, max: 200 };

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

/** Every value tape A's --rounds takes, in order, from the first parse of the document. */
const WATCH = `window.__rounds = [];
new MutationObserver(() => {
  const t = document.querySelector('[class*="NotFound_tapes"]');
  const a = t && t.children[0] && t.children[0].firstElementChild;
  const v = a ? a.style.getPropertyValue('--rounds') : '';
  if (v && window.__rounds[window.__rounds.length - 1] !== v) window.__rounds.push(v);
}).observe(document, { subtree: true, attributes: true, attributeFilter: ['style'], childList: true });`;

/** Computed width of tape A's track, read as NotFound.tsx reads it, at each number of rounds, from clones of its first round placed beside it. */
const WIDTHS_BY_ROUNDS = `(async () => {
  await document.fonts.ready;
  await new Promise((r) => setTimeout(r, 500));
  const a = document.querySelector('[class*="NotFound_tapes"]').children[0].firstElementChild;
  const round = [...a.children].slice(0, 3);
  const out = {};
  for (let r = ${ROUNDS.min}; r <= ${ROUNDS.max}; r++) {
    const c = a.cloneNode(false);
    c.style.animation = 'none';
    for (let i = 0; i < 2 * r; i++) for (const s of round) c.appendChild(s.cloneNode(true));
    a.parentElement.appendChild(c);
    out[r] = parseFloat(getComputedStyle(c).width);
    c.remove();
  }
  return out;
})()`;

/** Widths where NotFound.tsx's rule, run from MIN_ROUNDS on these measurements, never settles on one value. */
function unsettled(computed: Record<number, number>): number[] {
  const rule = (r: number, w: number) => Math.max(ROUNDS.min, Math.ceil((1.45 * w) / (computed[r]! / 2 / r)) + 1);
  const out: number[] = [];
  for (let w = SEARCH.from; w <= SEARCH.to; w++) {
    let r = ROUNDS.min;
    for (let i = 0; i < 40 && rule(r, w) !== r && rule(r, w) <= ROUNDS.max; i++) r = rule(r, w);
    if (rule(r, w) !== r && rule(r, w) <= ROUNDS.max) out.push(w);
  }
  return out;
}

type Case = { fonts: "served" | "never load"; width: number; settledAt: string; history: string[]; changesInOneSecond: number };
type Found = { fonts: "served" | "never load"; widths: number[] };

async function run(url: string): Promise<{ found: Found[]; cases: Case[] }> {
  const profile = mkdtempSync(join(tmpdir(), "a10-settle-wide-"));
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

    const open = async (width: number, fonts: Found["fonts"]) => {
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, true);
      cdp.session = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, true)).sessionId;
      const session = cdp.session;
      await cdp.send("Page.enable");
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
      let fail: ((m: Message) => void) | undefined;
      if (fonts === "never load") {
        fail = (m) => { if (m.method === "Fetch.requestPaused" && m.sessionId === session) void cdp.send("Fetch.failRequest", { requestId: m.params!.requestId, errorReason: "Failed" }); };
        cdp.listeners.push(fail);
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/fonts/*.woff2", requestStage: "Request" }] });
      }
      await cdp.send("Page.navigate", { url: `${url}/this-does-not-exist` });
      let up = false;
      for (let i = 0; i < 150 && !up; i++) {
        up = await cdp.evaluate<boolean>(`!!document.querySelector('[class*="NotFound_tapes"]') && document.readyState === 'complete'`).catch(() => false);
        if (!up) await sleep(100);
      }
      assert.ok(up, `${width}px: the 404 page never loaded`);
      return async () => { if (fail) cdp.listeners.splice(cdp.listeners.indexOf(fail), 1); await cdp.send("Target.closeTarget", { targetId }, true); };
    };

    const found: Found[] = [];
    const cases: Case[] = [];
    for (const fonts of ["served", "never load"] as const) {
      const close = await open(1440, fonts);
      const widths = unsettled(await cdp.evaluate<Record<number, number>>(WIDTHS_BY_ROUNDS));
      await close();
      found.push({ fonts, widths });
      for (const width of widths) {
        const shut = await open(width, fonts);
        await cdp.evaluate("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1500)))");
        const before = await cdp.evaluate<string[]>("window.__rounds.slice()");
        await sleep(1000);
        const after = await cdp.evaluate<string[]>("window.__rounds.slice()");
        cases.push({ fonts, width, settledAt: after[after.length - 1] ?? "", history: after.slice(0, 12), changesInOneSecond: after.length - before.length });
        await shut();
      }
    }
    return { found, cases };
  } finally {
    ws?.close();
    await stop(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("A10 adversary: the 404 tapes settle on one length at every width, measured by computed width", () => {
  let result: { found: Found[]; cases: Case[] } = { found: [], cases: [] };
  before(async function () {
    const url = process.env.A10_URL;
    if (!url) this.skip();
    result = await run(url.replace(/\/$/, ""));
  });

  it("found at least one width where the sizing rule, on this browser's measurements, does not settle", () => {
    const all = result.found.flatMap((f) => f.widths);
    assert.ok(all.length > 0, `no such width between ${SEARCH.from} and ${SEARCH.to}px on this machine, so the next test proves nothing: ${JSON.stringify(result.found)}`);
  });

  it("--rounds stops changing once the page has loaded", () => {
    for (const c of result.cases) {
      assert.equal(c.changesInOneSecond, 0,
        `${c.width}px, fonts ${c.fonts}: --rounds changed ${c.changesInOneSecond} times in one second after settling; ` +
        `first values ${c.history.join(",")}`);
    }
  });
});
