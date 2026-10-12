/**
 * PR #36 (Codex r2): the landing's Robinhood Chain "Try it on" card keeps its box in every state of the first-circle
 * read, so nothing on the page moves whether the read answers or fails, and the A9 layout-shift spec does not depend on
 * the RPC being up. Kept from the adversary pass on d0d84cb (othello-design/archive/adversary-pr36-d0d84cb), with a
 * failure mode added.
 *
 * The real production build (`next start`) in a real Chromium over the DevTools protocol. Every request to the
 * Robinhood Chain testnet RPC is held until the card has painted in "loading"; then either released to the real
 * endpoint unchanged ("ready": the real trusted factory answers) or failed on purpose ("error"). Widths 760 (the
 * narrowest that shows the landing; lib/phone.ts sends phones to /circles), 1024, 1280 and 1920 px, light, and 1280 px
 * dark. Pinned per run: loading links nowhere and nothing in it takes focus; the final state is the link ("ready") or
 * the card naming the failure ("error", no link); no layout shift at any time; the card and the section after the try
 * row keep their boxes; no hydration error.
 * Reuses app/.next when ADV_REUSE_BUILD=1; browser $CHROME, else Playwright's chrome-headless-shell (under WSL,
 * LD_LIBRARY_PATH may need its libs).
 *
 *   ADV_REUSE_BUILD=1 npx mocha --import=tsx --timeout 900000 tests/a10-try-card-states-shift.spec.ts
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
  on(l: (m: Message) => void): void { this.listeners.push(l); }
  once(method: string): Promise<Message> {
    return new Promise((r) => {
      const l = (m: Message) => { if (m.method === method && m.sessionId === this.session) { this.listeners.splice(this.listeners.indexOf(l), 1); r(m); } };
      this.listeners.push(l);
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  }
}

/** Before any page script: every layout shift with its sources, and the stored theme for the dark runs. */
const recorder = (dark: boolean) => `
  ${dark ? `try { localStorage.setItem("othello.theme", JSON.stringify({ choice: "r0", theme: "dark" })); } catch (e) {}` : `try { localStorage.clear(); } catch (e) {}`}
  window.__adv = { shifts: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__adv.shifts.push({ t: e.startTime, value: e.value, input: e.hadRecentInput,
    sources: (e.sources || []).map((s) => (s.node && s.node.nodeName) + " " + (s.node && s.node.className && String(s.node.className)) + " " + JSON.stringify(s.previousRect) + "->" + JSON.stringify(s.currentRect)) }); })
    .observe({ type: "layout-shift", buffered: true });
`;

/** The Robinhood card: the element carrying data-try-state in the "Try it on" row. */
const CARD = `document.querySelector('section[aria-labelledby="try-on"] [data-try-state]')`;
const SNAP = `(() => { const c = ${CARD}; if (!c) return null; const r = c.getBoundingClientRect();
  const sec = document.querySelector('section[aria-labelledby="try-on"]'); const after = sec.nextElementSibling.getBoundingClientRect();
  const focusables = [c, ...c.querySelectorAll('*')].filter((n) => n.tabIndex >= 0 || n.matches('a[href],button,[tabindex],input,select,textarea'));
  const visible = [...c.querySelectorAll('span')].filter((n) => !n.children.length && getComputedStyle(n).visibility === 'visible').map((n) => n.textContent);
  return { tag: c.tagName, state: c.getAttribute('data-try-state'), href: c.getAttribute('href'), visible, rect: [r.x, r.y, r.width, r.height],
    after: [after.x, after.y, after.width, after.height], focusables: focusables.map((n) => n.outerHTML.slice(0, 80)) }; })()`;

type Snap = { tag: string; state: string; href: string | null; visible: string[]; rect: number[]; after: number[]; focusables: string[] };
type Shift = { value: number; input: boolean; sources: string[] };

const RUNS: { width: number; dark: boolean; mode: "ready" | "error" }[] = [];
for (const mode of ["ready", "error"] as const) {
  for (const width of [760, 1024, 1280, 1920]) RUNS.push({ width, dark: false, mode });
  RUNS.push({ width: 1280, dark: true, mode });
}

describe("PR #36: the Robinhood try card keeps its box whether the first-circle read answers or fails", () => {
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
    profile = mkdtempSync(join(tmpdir(), "a10-trycard-"));
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

  for (const { width, dark, mode } of RUNS) {
    it(`${mode}, ${width} px, ${dark ? "dark" : "light"}: no link while loading, the right final state, and nothing moves`, async () => {
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, true);
      cdp.session = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, true)).sessionId;
      const session = cdp.session;
      const errors: string[] = [];
      const held: string[] = [];
      let releasing = false;
      let rpcSeen = 0;
      const answer = (requestId: string) =>
        mode === "ready" ? cdp.send("Fetch.continueRequest", { requestId }) : cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
      cdp.on((m) => {
        if (m.sessionId !== session) return;
        if (m.method === "Fetch.requestPaused") {
          rpcSeen++;
          const id = String(m.params!.requestId);
          if (releasing) void answer(id); else held.push(id);
        }
        if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params).slice(0, 400));
        if (m.method === "Runtime.consoleAPICalled" && (m.params as { type: string }).type === "error")
          errors.push(JSON.stringify((m.params as { args: unknown }).args).slice(0, 400));
      });
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*${RPC_HOST}*`, requestStage: "Request" }] });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: recorder(dark) });

      const loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: `${base}/` });
      await loaded;
      await cdp.evaluate("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1500)))");
      await cdp.evaluate(`(${CARD}).scrollIntoView({ block: "center" }), new Promise((r) => setTimeout(r, 300))`);

      const before = await cdp.evaluate<Snap>(SNAP);
      assert.ok(before, "no Robinhood try card on the landing");
      assert.ok(rpcSeen > 0, "the card never asked the RPC; the read path under test did not run");
      assert.equal(before.state, "loading");
      assert.notEqual(before.tag, "A", `loading card is a link: ${before.href}`);
      assert.deepEqual(before.focusables, [], "something in the loading card takes keyboard focus");
      const shiftsBefore = await cdp.evaluate<Shift[]>("window.__adv.shifts");

      releasing = true;
      for (const id of held.splice(0)) await answer(id);
      const end = Date.now() + 45_000;
      let final = await cdp.evaluate<Snap>(SNAP);
      while (final.state === "loading" && Date.now() < end) { await sleep(200); final = await cdp.evaluate<Snap>(SNAP); }
      await sleep(1000);
      final = await cdp.evaluate<Snap>(SNAP);
      const shifts = await cdp.evaluate<Shift[]>("window.__adv.shifts");

      await cdp.send("Fetch.disable");
      await cdp.send("Target.closeTarget", { targetId }, true);

      if (mode === "ready") {
        assert.equal(final.state, "ready", `the real read never made the card a link; it shows: ${final.visible.join(" | ")}`);
        assert.equal(final.tag, "A");
        assert.match(final.href ?? "", /^\/circle\/rh:0x[0-9a-fA-F]{40}$/);
        assert.deepEqual(final.visible.slice(1), before.visible.slice(1), "the card's words changed when it became a link");
      } else {
        assert.equal(final.state, "error", `a failed read left the card in ${final.state}`);
        assert.notEqual(final.tag, "A", `a failed read made the card a link: ${final.href}`);
        assert.ok(final.visible.some((t) => /could not be read/.test(t)), `the card does not say the read failed: ${final.visible.join(" | ")}`);
      }
      assert.deepEqual(shiftsBefore.filter((x) => x.value > 0), [], "the page shifted before the read answered");
      assert.deepEqual(shifts.filter((x) => x.value > 0), [], `the read ${mode === "ready" ? "answering" : "failing"} shifted the layout`);
      assert.deepEqual(final.rect, before.rect, "the card's box moved");
      assert.deepEqual(final.after, before.after, "the section after the try row moved");
      assert.deepEqual(errors.filter((e) => /hydrat|#418|#423|#425|did not match/i.test(e)), [], "hydration error");
    });
  }
});
