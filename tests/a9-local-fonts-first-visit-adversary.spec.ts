/**
 * Adversary, A9 local fonts (Joshua, 2026-10-08), pass on 5791d57. The spec: "no new layout shift on a first visit OR
 * a returning visit".
 *
 * A first visit (fresh browser profile, empty HTTP cache) on a slow link, against a running production server. Measures
 * the layout shift total and which faces are loaded at first contentful paint, several times, and prints them so two
 * builds can be compared: A9_BASE=<url of a server built from 266fe77> A9_NEW=<url of a server built from this commit>.
 * Pinned: the new build's worst first-visit shift is no larger than the old build's worst. "Faces at FCP" is printed
 * only as a hint: the paint observer's callback runs after the paint, so it is not a reliable measure on its own.
 * Browser: $CHROME, else Playwright's cached chrome-headless-shell (under WSL, LD_LIBRARY_PATH may need its libs).
 *
 *   A9_BASE=http://127.0.0.1:3918 A9_NEW=http://127.0.0.1:3917 npx mocha --import=tsx --timeout 900000 tests/a9-local-fonts-first-visit-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const RUNS = Number(process.env.A9_RUNS ?? 5);
const PATH = process.env.A9_PATH ?? "/";
const COND = { offline: false, latency: Number(process.env.A9_LATENCY ?? 150), downloadThroughput: Number(process.env.A9_DOWN ?? 200_000), uploadThroughput: 90_000 };

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

const RECORDER = `
  window.__a9 = { shift: 0, atFcp: null };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__a9.shift += e.value; })
    .observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint" && !window.__a9.atFcp)
    window.__a9.atFcp = [...document.fonts].filter((f) => f.status === "loaded").length;
  }).observe({ type: "paint", buffered: true });
`;
const SETTLE = "document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1500)))";
type Visit = { shift: number; atFcp: number | null };

/** One first visit: a new Chromium with an empty profile, so nothing is cached. */
async function firstVisit(url: string): Promise<Visit> {
  const profile = mkdtempSync(join(tmpdir(), "a9-first-"));
  const chrome = spawn(chromeBin(), ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--force-prefers-reduced-motion", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
    await cdp.send("Network.emulateNetworkConditions", COND);
    await cdp.goto(url);
    await cdp.evaluate(SETTLE);
    return await cdp.evaluate<Visit>("window.__a9");
  } finally {
    ws?.close();
    await stop(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("A9 adversary: a first visit on a slow link", () => {
  it("shifts no more than the next/font/google build did", async function () {
    const base = process.env.A9_BASE;
    const now = process.env.A9_NEW;
    if (!base || !now) this.skip();
    const old: Visit[] = [];
    const neu: Visit[] = [];
    for (let i = 0; i < RUNS; i++) {
      old.push(await firstVisit(`${base}${PATH}`));
      neu.push(await firstVisit(`${now}${PATH}`));
    }
    const fmt = (v: Visit[]) => v.map((x) => `${x.shift.toFixed(4)} (faces at FCP ${x.atFcp})`).join(", ");
    console.log(`  base: ${fmt(old)}\n  new:  ${fmt(neu)}`);
    const worst = (v: Visit[]) => Math.max(...v.map((x) => x.shift));
    assert.ok(worst(neu) <= worst(old) + 1e-6, `first visit: new worst shift ${worst(neu)} exceeds base worst ${worst(old)}\n  base: ${fmt(old)}\n  new:  ${fmt(neu)}`);
  });
});
