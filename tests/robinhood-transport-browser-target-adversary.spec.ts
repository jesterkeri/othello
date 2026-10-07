/**
 * Adversary on 22d724c (PR #25). Spec 4: "the app builds for the browser (AbortSignal.any, AbortSignal.timeout) as it
 * targets". Spec 1: every Robinhood read through robinhoodPublicClient ends in success or a fixed-sentence failure.
 *
 * lib/robinhood/transport.ts's fetch calls `AbortSignal.any([init.signal, limit])` whenever viem passes a signal, and
 * viem's http client always passes one when its timeout is above 0 (utils/rpc/http.ts: `signal: signal_ || (timeout >
 * 0 ? signal : null)`), so every request the app makes goes through AbortSignal.any. app/ has no browserslist config,
 * so `next build` targets Next's defaults (next/dist/shared/lib/modern-browserslist-target.js: chrome 64, edge 79,
 * firefox 67, opera 51, safari 12). Next ships no AbortSignal.any polyfill (build/polyfills has none), and tsc's DOM
 * lib types it, so typecheck and build stay green.
 *
 * AbortSignal.any first shipped in Chrome 116, Edge 116, Opera 102, Firefox 124 and Safari 17.4 (MDN browser-compat-
 * data, api.AbortSignal.any; https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static#browser_compatibility,
 * read 2026-10-07). In a targeted browser below those (for example Safari or iOS 17.0 to 17.3, Chrome 103 to 115) the
 * property is undefined: boundedFetch throws a TypeError before any request leaves, viem wraps it as an
 * HttpRequestError and retries it three times, and every read fails, every time, including Try again. Before 22d724c
 * the same client (viem http, batch: true) read fine there.
 *
 * Harness: a local anvil (no public RPC). The browser without AbortSignal.any is simulated by removing the static for
 * the duration of one read, then restoring it. Control: viem's bare http transport, as wallet.ts built it before.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/robinhood-transport-browser-target-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { createPublicClient, defineChain, http } from "viem";

import { robinhoodHttp } from "../app/src/lib/robinhood/transport.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const nextRequire = createRequire(join(ROOT, "app", "package.json"));
const { getSupportedBrowsers } = nextRequire("next/dist/build/utils.js") as { getSupportedBrowsers: (dir: string, dev: boolean) => string[] };

// first version with AbortSignal.any, per MDN browser-compat-data (api.AbortSignal.any), read 2026-10-07
const ANY_SINCE: Record<string, number> = { chrome: 116, edge: 116, opera: 102, firefox: 124, safari: 17.4, ios_saf: 17.4 };

const PORT = 8987;
const ANVIL = `http://127.0.0.1:${PORT}`;
const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } },
});

/** Runs `read` as it would run in a browser that has AbortSignal.timeout but not AbortSignal.any. */
async function withoutAbortSignalAny<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const desc = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  assert.ok(desc, "precondition: this Node has AbortSignal.any to remove");
  delete (AbortSignal as unknown as { any?: unknown }).any;
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    const err = e as Error & { cause?: Error; details?: string };
    return { ok: false, error: `${err.name}: ${err.details ?? err.cause?.message ?? err.message}` };
  } finally {
    Object.defineProperty(AbortSignal, "any", desc);
  }
}

describe("Adversary on 22d724c: robinhoodHttp needs AbortSignal.any, which browsers the app targets do not have", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    const pub = createPublicClient({ chain, transport: http(ANVIL) });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); return; } catch { await sleep(100); }
    }
    throw new Error("anvil did not start");
  });
  after(() => { anvil?.kill(); });

  it("precondition: the app's build targets include browsers that predate AbortSignal.any", () => {
    const targets = getSupportedBrowsers(join(ROOT, "app"), false);
    const older = targets.filter((t) => {
      const [name, version] = t.split(" ");
      const since = ANY_SINCE[name!];
      return since !== undefined && Number.parseFloat(version!) < since;
    });
    assert.ok(older.length > 0, `every build target has AbortSignal.any (targets: ${targets.join(", ")})`);
  });

  it("control: viem's bare http transport (wallet.ts before 22d724c) reads in such a browser", async () => {
    const client = createPublicClient({ chain, transport: http(ANVIL, { batch: true }) });
    const r = await withoutAbortSignalAny(() => client.getChainId());
    assert.deepEqual(r, { ok: true, value: 46630 });
  });

  it("a read through robinhoodHttp, the app's transport, still answers in such a browser", async () => {
    const client = createPublicClient({ chain, transport: robinhoodHttp(ANVIL) });
    const r = await withoutAbortSignalAny(() => client.getChainId());
    assert.deepEqual(r, { ok: true, value: 46630 },
      "robinhoodHttp's fetch calls AbortSignal.any on every request, so in a targeted browser without it every " +
      "Robinhood read fails, and Try again fails the same way");
  });
});
