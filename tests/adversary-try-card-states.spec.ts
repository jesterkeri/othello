/**
 * Adversary on PR #36 bcc791f: the landing's Robinhood Chain "Try it on" card in all four states of useFirstCircle,
 * including "none", which tests/a10-try-card-states-shift.spec.ts never reaches.
 *
 * The real production build (`next start`) in a real Chromium over the DevTools protocol. Robinhood Chain testnet RPC
 * requests are held (loading), released to the real endpoint ("ready"), failed ("error"), or forwarded to the real
 * endpoint with only the factory's `circleCount()` answer (selector 0xcf0b1117) replaced by zero ("none": the trusted
 * factory with no circle; the getCode reply and its pinned code hash stay real).
 *
 * 1. "none" at 760, 1024, 1280, 1920 px light and 1280 px dark: no link, says so in visible words, nothing moves.
 * 2. One tab per state, every width in 760..800 px and 1000..1100 px plus 1280, 1440, 1920, 2560 px, light and dark,
 *    and device scale 1.25, 1.5, 2: the card and the section after the row have the same box in all four states.
 * 3. The hidden messages: not in the accessibility tree, not in innerText, not in a select-all copy, not focusable.
 *
 *   ADV_REUSE_BUILD=1 npx mocha --import=tsx --timeout 900000 tests/adversary-try-card-states.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REPO } from "./artifacts.ts";

const APP = resolve(process.env.A9_APP ?? join(REPO, "app"));
const RPC_HOST = "rpc.testnet.chain.robinhood.com";
const CIRCLE_COUNT = "0xcf0b1117";
const MESSAGES = {
  circle: "A finished savings circle in USDG, every round paid out.",
  none: "No circle on Robinhood Chain testnet yet.",
  error: "Robinhood Chain testnet could not be read right now.",
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: unknown };
class Cdp {
  private next = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private listeners: ((m: Message) => void)[] = [];
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Message;
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (p) { this.pending.delete(m.id!); if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result); }
      else for (const l of [...this.listeners]) l(m);
    });
  }
  send<T = Record<string, unknown>>(session: string | null, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.next;
    return new Promise((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }
  on(l: (m: Message) => void): () => void { this.listeners.push(l); return () => this.listeners.splice(this.listeners.indexOf(l), 1); }
  once(session: string, method: string): Promise<Message> {
    return new Promise((r) => {
      const off = this.on((m) => { if (m.method === method && m.sessionId === session) { off(); r(m); } });
    });
  }
  async evaluate<T>(session: string, expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>(session, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  }
}

const recorder = (dark: boolean) => `
  ${dark ? `try { localStorage.setItem("othello.theme", JSON.stringify({ choice: "r0", theme: "dark" })); } catch (e) {}` : `try { localStorage.clear(); } catch (e) {}`}
  window.__adv = { shifts: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__adv.shifts.push({ t: e.startTime, value: e.value, input: e.hadRecentInput,
    sources: (e.sources || []).map((s) => (s.node && s.node.nodeName) + " " + JSON.stringify(s.previousRect) + "->" + JSON.stringify(s.currentRect)) }); })
    .observe({ type: "layout-shift", buffered: true });
`;

const CARD = `document.querySelector('section[aria-labelledby="try-on"] [data-try-state]')`;
const SNAP = `(() => { const c = ${CARD}; if (!c) return null; const r = c.getBoundingClientRect();
  const sec = document.querySelector('section[aria-labelledby="try-on"]'); const after = sec.nextElementSibling.getBoundingClientRect();
  const row = c.parentElement.getBoundingClientRect();
  const focusables = [c, ...c.querySelectorAll('*')].filter((n) => n.tabIndex >= 0 || n.matches('a[href],button,[tabindex],input,select,textarea'));
  const visible = [...c.querySelectorAll('span')].filter((n) => !n.children.length && getComputedStyle(n).visibility === 'visible').map((n) => n.textContent);
  return { tag: c.tagName, state: c.getAttribute('data-try-state'), href: c.getAttribute('href'), visible,
    rect: [r.x, r.y, r.width, r.height], row: [row.x, row.y, row.width, row.height], after: [after.x, after.y, after.width, after.height],
    scrollH: document.documentElement.scrollHeight, focusables: focusables.map((n) => n.outerHTML.slice(0, 80)) }; })()`;
type Snap = { tag: string; state: string; href: string | null; visible: string[]; rect: number[]; row: number[]; after: number[]; scrollH: number; focusables: string[] };
type Shift = { value: number; input: boolean; sources: string[] };
type Mode = "loading" | "ready" | "none" | "error";

describe("adversary PR #36 bcc791f: the Robinhood try card in all four first-circle states", () => {
  let server: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let profile: string | undefined;
  let ws: WebSocket | undefined;
  let base = "";
  let cdp: Cdp;

  before(async () => {
    const next = join(APP, "node_modules/.bin/next");
    assert.ok(existsSync(next), `no next binary at ${next}`);
    if (process.env.ADV_REUSE_BUILD !== "1" || !existsSync(join(APP, ".next/BUILD_ID"))) {
      const b = spawnSync(next, ["build"], { cwd: APP, encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(b.status, 0, `next build failed:\n${b.stdout}\n${b.stderr}`);
    }
    const port = await freePort();
    server = spawn(next, ["start", "-p", String(port), "-H", "127.0.0.1"], { cwd: APP, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/`, 60_000);
    profile = mkdtempSync(join(tmpdir(), "adv-trycard-"));
    chrome = spawn(chromeBin(), ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--force-prefers-reduced-motion", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise<string>((res, rej) => {
      let err = "";
      chrome!.stderr!.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res(m[1]!); });
      chrome!.once("exit", (c) => rej(new Error(`chrome exited ${c}: ${err}`)));
    });
    ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws!.addEventListener("open", r); ws!.addEventListener("error", j); });
    cdp = new Cdp(ws);
  });

  after(async () => {
    ws?.close();
    await stop(chrome);
    await stop(server);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  /** Forward a paused request to the real RPC; replace only circleCount()'s result with zero. */
  async function answerNone(s: string, p: Record<string, unknown>): Promise<void> {
    const req = p.request as { url: string; method: string; postData?: string; headers: Record<string, string> };
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "*" },
      { name: "access-control-allow-methods", value: "POST, OPTIONS" },
    ];
    if (req.method === "OPTIONS") {
      await cdp.send(s, "Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 204, responseHeaders: cors });
      return;
    }
    const body = JSON.parse(req.postData ?? "null") as { id: number; method: string; params: [{ data?: string; input?: string }] } | { id: number; method: string; params: [{ data?: string; input?: string }] }[];
    const r = await fetch(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData });
    const out = (await r.json()) as { id: number; result?: string } | { id: number; result?: string }[];
    const items = Array.isArray(body) ? body : [body];
    const outs = Array.isArray(out) ? out : [out];
    for (const it of items) {
      const data = (it.params?.[0]?.data ?? it.params?.[0]?.input ?? "") as string;
      if (it.method === "eth_call" && data.toLowerCase().startsWith(CIRCLE_COUNT)) {
        const o = outs.find((x) => x.id === it.id);
        if (o) o.result = "0x" + "0".repeat(64);
        noneRewrites++;
      }
    }
    await cdp.send(s, "Fetch.fulfillRequest", {
      requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }, ...cors],
      body: Buffer.from(JSON.stringify(out)).toString("base64"),
    });
  }
  let noneRewrites = 0;

  /** Open the landing in a new tab with RPC requests held; returns the session and a release function. */
  async function open(width: number, dark: boolean, mode: Mode, scale = 1) {
    const { targetId } = await cdp.send<{ targetId: string }>(null, "Target.createTarget", { url: "about:blank" });
    const s = (await cdp.send<{ sessionId: string }>(null, "Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const errors: string[] = [];
    const held: Record<string, unknown>[] = [];
    let releasing = false;
    let rpcSeen = 0;
    const answer = (p: Record<string, unknown>) => {
      const requestId = String(p.requestId);
      if (mode === "ready") return cdp.send(s, "Fetch.continueRequest", { requestId });
      if (mode === "error") return cdp.send(s, "Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
      if (mode === "none") return answerNone(s, p);
      return Promise.resolve();
    };
    const off = cdp.on((m) => {
      if (m.sessionId !== s) return;
      if (m.method === "Fetch.requestPaused") {
        rpcSeen++;
        if (releasing) void answer(m.params!).catch((e) => errors.push(`answer: ${e}`)); else held.push(m.params!);
      }
      if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params).slice(0, 400));
      if (m.method === "Runtime.consoleAPICalled" && (m.params as { type: string }).type === "error")
        errors.push(JSON.stringify((m.params as { args: unknown }).args).slice(0, 400));
    });
    await cdp.send(s, "Page.enable");
    await cdp.send(s, "Runtime.enable");
    await cdp.send(s, "Fetch.enable", { patterns: [{ urlPattern: `*${RPC_HOST}*`, requestStage: "Request" }] });
    await cdp.send(s, "Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: scale, mobile: false });
    await cdp.send(s, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await cdp.send(s, "Page.addScriptToEvaluateOnNewDocument", { source: recorder(dark) });
    const loaded = cdp.once(s, "Page.loadEventFired");
    await cdp.send(s, "Page.navigate", { url: `${base}/` });
    await loaded;
    await cdp.evaluate(s, "document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 800)))");
    await cdp.evaluate(s, `(${CARD}).scrollIntoView({ block: "center" }), new Promise((r) => setTimeout(r, 200))`);
    return {
      s, errors, rpcSeen: () => rpcSeen,
      async release(): Promise<Snap> {
        releasing = true;
        for (const p of held.splice(0)) await answer(p);
        const end = Date.now() + 45_000;
        let final = await cdp.evaluate<Snap>(s, SNAP);
        while (final.state === "loading" && Date.now() < end) { await sleep(200); final = await cdp.evaluate<Snap>(s, SNAP); }
        await sleep(800);
        return cdp.evaluate<Snap>(s, SNAP);
      },
      async close() { off(); await cdp.send(s, "Fetch.disable").catch(() => {}); await cdp.send(null, "Target.closeTarget", { targetId }); },
    };
  }

  for (const { width, dark } of [{ width: 760, dark: false }, { width: 1024, dark: false }, { width: 1280, dark: false }, { width: 1920, dark: false }, { width: 1280, dark: true }]) {
    it(`none, ${width} px, ${dark ? "dark" : "light"}: the factory has no circle; no link, says so, nothing moves`, async () => {
      noneRewrites = 0;
      const t = await open(width, dark, "none");
      const before = await cdp.evaluate<Snap>(t.s, SNAP);
      assert.ok(t.rpcSeen() > 0, "the card never asked the RPC");
      assert.equal(before.state, "loading");
      const shiftsBefore = await cdp.evaluate<Shift[]>(t.s, "window.__adv.shifts");
      const final = await t.release();
      const shifts = await cdp.evaluate<Shift[]>(t.s, "window.__adv.shifts");
      const errors = t.errors;
      await t.close();
      assert.ok(noneRewrites > 0, "circleCount() was never rewritten; the stub did not run");
      assert.equal(final.state, "none", `the card ended in ${final.state}: ${final.visible.join(" | ")}`);
      assert.notEqual(final.tag, "A", `"none" made the card a link: ${final.href}`);
      assert.deepEqual(final.focusables, [], "something in the none card takes focus");
      assert.ok(final.visible.some((v) => v === MESSAGES.none), `the card does not say there is no circle: ${final.visible.join(" | ")}`);
      assert.ok(!final.visible.some((v) => v.startsWith(MESSAGES.circle) || v.startsWith(MESSAGES.error)), `other words visible: ${final.visible.join(" | ")}`);
      assert.deepEqual(shiftsBefore.filter((x) => x.value > 0), [], "the page shifted before the read answered");
      assert.deepEqual(shifts.filter((x) => x.value > 0), [], "the read answering 'none' shifted the layout");
      assert.deepEqual(final.rect, before.rect, "the card's box moved");
      assert.deepEqual(final.after, before.after, "the section after the try row moved");
      assert.deepEqual(errors.filter((e) => /hydrat|#418|#423|#425|did not match|answer:/i.test(e)), [], "hydration or stub error");
    });
  }

  const SWEEP = [
    ...Array.from({ length: 41 }, (_, i) => 760 + i),
    ...Array.from({ length: 51 }, (_, i) => 1000 + 2 * i),
    1180, 1280, 1366, 1440, 1600, 1920, 2560,
  ];

  for (const { dark, scale } of [{ dark: false, scale: 1 }, { dark: true, scale: 1 }, { dark: false, scale: 1.25 }, { dark: false, scale: 1.5 }, { dark: false, scale: 2 }]) {
    it(`${dark ? "dark" : "light"}, device scale ${scale}: the card and what follows have one box in all four states at ${SWEEP.length} widths`, async () => {
      const boxes: Record<Mode, Map<number, Snap>> = { loading: new Map(), ready: new Map(), none: new Map(), error: new Map() };
      const sweep = async (s: string, into: Map<number, Snap>) => {
        for (const w of SWEEP) {
          await cdp.send(s, "Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: scale, mobile: false });
          into.set(w, await cdp.evaluate<Snap>(s, `new Promise((r) => requestAnimationFrame(() => r(${SNAP})))`));
        }
      };
      // loading: swept while the read is still held (the transport aborts a request after 10 s, so keep it short)
      const l = await open(1280, dark, "loading", scale);
      const t0 = Date.now();
      await sweep(l.s, boxes.loading);
      const stillLoading = await cdp.evaluate<Snap>(l.s, SNAP);
      await l.close();
      assert.equal(stillLoading.state, "loading", `the loading tab left loading during the sweep (${Date.now() - t0} ms)`);
      for (const mode of ["ready", "none", "error"] as const) {
        const t = await open(1280, dark, mode, scale);
        const f = await t.release();
        assert.equal(f.state, mode, `the ${mode} tab ended in ${f.state}`);
        await sweep(t.s, boxes[mode]);
        await t.close();
      }
      const diffs: string[] = [];
      for (const w of SWEEP) {
        const ref = boxes.loading.get(w)!;
        assert.equal(ref.state, "loading");
        for (const mode of ["ready", "none", "error"] as const) {
          const b = boxes[mode].get(w)!;
          assert.equal(b.state, mode);
          for (const k of ["rect", "row", "after", "scrollH"] as const) {
            if (JSON.stringify(b[k]) !== JSON.stringify(ref[k])) diffs.push(`${w}px ${mode} ${k}: loading ${JSON.stringify(ref[k])} vs ${JSON.stringify(b[k])}`);
          }
        }
      }
      assert.deepEqual(diffs, [], "the card's box differs between states");
    });
  }

  for (const mode of ["loading", "ready", "none", "error"] as const) {
    it(`${mode}: the hidden messages are not in the accessibility tree, innerText or a copy`, async () => {
      const t = await open(1280, false, mode);
      if (mode !== "loading") {
        const f = await t.release();
        assert.equal(f.state, mode);
      }
      const shown = mode === "loading" || mode === "ready" ? MESSAGES.circle : MESSAGES[mode];
      const hidden = Object.values(MESSAGES).filter((m) => m !== shown);
      await cdp.send(t.s, "Accessibility.enable");
      const { nodes } = await cdp.send<{ nodes: { ignored?: boolean; name?: { value?: string }; properties?: unknown[] }[] }>(t.s, "Accessibility.getFullAXTree");
      const axText = nodes.filter((n) => !n.ignored).map((n) => n.name?.value ?? "").join("\n");
      const inner = await cdp.evaluate<string>(t.s, `(${CARD}).innerText`);
      const copied = await cdp.evaluate<string>(t.s, `(() => { const r = document.createRange(); r.selectNodeContents(${CARD}); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return sel.toString(); })()`);
      const pageCopy = await cdp.evaluate<string>(t.s, `(() => { const sel = getSelection(); sel.removeAllRanges(); sel.selectAllChildren(document.body); return sel.toString(); })()`);
      await t.close();
      assert.ok(axText.includes(shown), `the visible message is missing from the accessibility tree: ${shown}`);
      for (const h of hidden) {
        assert.ok(!axText.includes(h), `hidden message read out by assistive technology: ${h}`);
        assert.ok(!inner.includes(h), `hidden message in innerText: ${h}`);
        assert.ok(!copied.includes(h), `hidden message in a copy of the card: ${h}`);
        assert.ok(!pageCopy.includes(h), `hidden message in a select-all copy: ${h}`);
      }
    });
  }
});
