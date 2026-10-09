/**
 * Adversary, A9 local fonts (Joshua, 2026-10-08), pass on 756312e. The spec: "The site must render EXACTLY as before
 * on every page ... and the same fallback while fonts load (font-display swap, the same Arial fallback metrics so
 * there is no new layout shift)."
 *
 * next/font/google served the ten files from /_next/static/media with `Cache-Control: public, max-age=31536000,
 * immutable`. app/public/fonts is served by `next start` with `public, max-age=0` (Vercel: `public, max-age=0,
 * must-revalidate`), so a returning visitor's browser holds the fonts but must revalidate each one (a 304) before it
 * may use it. On any real link the first frame is painted before that round trip ends: the page paints in the Arial
 * fallback, then swaps to Archivo and Plus Jakarta Sans, and the swap shifts the layout (Arial has no condensed
 * face, so the 68-70% Archivo headlines change width). Before the switch a returning visit painted its first frame
 * in the real fonts, with no shift.
 *
 * The real production build (`next build`, then `next start`) in a real Chromium, driven over the DevTools protocol:
 * visit 1 fills the HTTP cache, then visit 2 (same browser profile, a new document) runs with 300 ms of emulated
 * latency, a slow mobile link. Pinned: every face loaded at visit 1 is loaded at visit 2's first contentful paint,
 * and visit 2 has no layout shift. Against a build of 266fe77 (next/font/google) both hold.
 * Browser: $CHROME, else Playwright's cached chrome-headless-shell (under WSL, LD_LIBRARY_PATH may need its libs).
 * A9_APP=<an app dir> runs it against another checkout's app (e.g. 266fe77's); A9_REUSE_BUILD=1 skips the build.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/a9-local-fonts-returning-visit-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REPO } from "./artifacts.ts";

const APP = resolve(process.env.A9_APP ?? join(REPO, "app"));
const LATENCY_MS = 300;

function chromeBin(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const d of existsSync(cache) ? readdirSync(cache) : []) {
    const bin = join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (d.startsWith("chromium_headless_shell") && existsSync(bin)) return bin;
  }
  throw new Error("no Chromium: set CHROME, or install Playwright's chrome-headless-shell");
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? res(a.port) : rej(new Error("no port"))));
    });
  });
}

async function waitFor(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${url} did not answer in ${ms} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function stop(p: ChildProcess | undefined): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return new Promise((r) => { p.once("exit", () => r()); p.kill("SIGTERM"); });
}

/** A minimal DevTools protocol client over one flattened page session. */
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
  on(l: (m: Message) => void): void {
    this.listeners.push(l);
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

/** Installed before any page script: the layout shift total, and which faces are loaded at first contentful paint. */
const RECORDER = `
  window.__a9 = { shift: 0, atFcp: null };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__a9.shift += e.value; })
    .observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint" && !window.__a9.atFcp)
    window.__a9.atFcp = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family + " " + f.style + " " + f.weight + " " + f.unicodeRange.split(",")[0]);
  }).observe({ type: "paint", buffered: true });
`;
const SETTLE = "document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1500)))";
type Visit = { shift: number; atFcp: string[] | null };

describe("A9 adversary: a returning visitor's first frame on a slow link", () => {
  let server: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let profile: string | undefined;
  let ws: WebSocket | undefined;

  after(async () => {
    ws?.close();
    await stop(chrome);
    await stop(server);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("paints in the site's fonts, with no layout shift, as next/font/google's immutable files did", async () => {
    const next = join(APP, "node_modules/.bin/next");
    assert.ok(existsSync(next), `no next binary at ${next} (pnpm -C app install --frozen-lockfile)`);
    if (process.env.A9_REUSE_BUILD !== "1" || !existsSync(join(APP, ".next/BUILD_ID"))) {
      const b = spawnSync(next, ["build"], { cwd: APP, encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(b.status, 0, `next build failed:\n${b.stdout}\n${b.stderr}`);
    }
    const port = await freePort();
    server = spawn(next, ["start", "-p", String(port), "-H", "127.0.0.1"], { cwd: APP, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/`, 60_000);

    profile = mkdtempSync(join(tmpdir(), "a9-returning-"));
    chrome = spawn(chromeBin(), ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--force-prefers-reduced-motion", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise<string>((res, rej) => {
      let err = "";
      chrome!.stderr!.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res(m[1]!); });
      chrome!.once("exit", (c) => rej(new Error(`chrome exited ${c}: ${err}`)));
    });
    ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws!.addEventListener("open", r); ws!.addEventListener("error", j); });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, true);
    cdp.session = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, true)).sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });

    // visit 1: fills the HTTP cache
    await cdp.goto(`${base}/`);
    await cdp.evaluate(SETTLE);
    const first = await cdp.evaluate<Visit>("window.__a9");
    const faces = await cdp.evaluate<string[]>(`[...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family + " " + f.style + " " + f.weight + " " + f.unicodeRange.split(",")[0])`);
    assert.ok(faces.length >= 3, `visit 1 loaded only ${faces.length} faces: ${faces.join("; ")}`);
    assert.equal(first.shift, 0, "visit 1 already shifts; the baseline is not clean");
    await cdp.goto("about:blank");

    // visit 2: the same visitor, a new document, a slow link
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 });
    const revalidated: string[] = [];
    const onResponse = (m: Message) => {
      const r = (m.params?.response ?? {}) as { url?: string; status?: number; headers?: Record<string, string> };
      if (m.method === "Network.responseReceived" && /\.woff2$/.test(r.url ?? "") && r.status === 304)
        revalidated.push(`${r.url!.replace(base, "")} (cache-control: ${r.headers?.["cache-control"] ?? r.headers?.["Cache-Control"]})`);
    };
    cdp.on(onResponse);
    await cdp.goto(`${base}/`);
    await cdp.evaluate(SETTLE);
    const second = await cdp.evaluate<Visit>("window.__a9");

    const missing = faces.filter((f) => !(second.atFcp ?? []).includes(f));
    assert.deepEqual(missing, [], `returning visit: faces not yet loaded at first contentful paint (painted in the Arial fallback); revalidated before use: ${revalidated.join(", ") || "none"}`);
    assert.equal(second.shift, 0, `returning visit: layout shift ${second.shift} from the font swap`);
  });
});
