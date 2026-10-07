/**
 * A6 adversary on 949f7dc (PR #25, the shared circles list). Spec item 3: "The wait for settling is bounded: a page
 * never hangs forever on one slow call (the transport's timeout applies), and the list shows its Reading/Looking state
 * meanwhile." Spec item 1: the page fails once every call it sent has settled, with a fixed sentence and Try again.
 *
 * listCirclesPageWith and summarize (app/src/lib/robinhood/adapter-core.ts) now wait for every call of a round with
 * allSettledOrThrow before failing. That wait is only as bounded as each call, and viem's http transport bounds only
 * the wait for the response HEADERS: withTimeout (viem/utils/promise/withTimeout.ts) clears its timer as soon as fetch
 * resolves, and readResponseBody (viem/utils/rpc/http.ts) then reads the body with no timeout at all. An RPC or proxy
 * that answers "200" and then stalls its body (an overloaded load balancer) leaves that one call pending for as long
 * as the socket stays open: forever in a browser. Before 949f7dc the page's Promise.all failed at the first refused
 * call, so the list drew its error and Try again; now the refused call's sibling holds the page, the error is never
 * drawn and the list says "Looking for your circles..." with no way out but a reload.
 *
 * Harness: real MockUSDG and OthelloFactory on a local anvil (chain 46630); wallet A creates one circle with
 * createCircle; TRUSTED_FACTORY points at the anvil factory with its real code hash; the real useRobinhoodCircles, run
 * by the hook runner of tests/a6-circles-rh-retry-viem-adversary.spec.ts, reads through a real viem http client
 * (batch on, default timeout and retries, as in lib/robinhood/wallet.ts) pointed at a local JSON-RPC relay in front of
 * anvil. The relay refuses the circle's listing "n" read with a non-retryable error (-32000) and answers its first
 * listing "c" read with -32603 (retryable, as a rate-limited RPC would). The HTTP request that carries viem's retry of
 * "c" gets its status line and headers, then no body. The test waits 90 s, more than twice viem's own worst case for
 * one call (4 tries of 10 s plus 1.05 s of backoff), and expects the list to have drawn its error by then.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-rh-stalled-body-adversary.spec.ts
 * Hook-installing spec: run it in its own process.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { robinhoodHttp } from "../app/src/lib/robinhood/transport.ts";
import { mnemonicToAccount } from "viem/accounts";

import { REPO } from "./artifacts.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";

const SRC = resolve(REPO, "app/src");
const PORT = 8761;
const RELAY_PORT = 8762;
const ANVIL = `http://127.0.0.1:${PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const U = 1_000_000n;
const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

type Slot = { v?: unknown; current?: unknown; f?: unknown; d?: unknown[]; cleanup?: unknown };
const g = globalThis as {
  __a6t?: ReturnType<typeof hooks>; __a6tWallet?: string; __a6tClient?: unknown; __a6tFactory?: unknown;
};

/** One component's hooks, run by hand: state persists across renders, effects run when their deps change. */
function hooks() {
  const slots: Slot[] = [];
  const queue: (() => void)[] = [];
  let i = 0;
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((x, k) => Object.is(x, b[k])));
  return {
    begin() {
      i = 0;
    },
    useState(init: unknown) {
      const k = i++;
      if (!slots[k]) slots[k] = { v: typeof init === "function" ? (init as () => unknown)() : init };
      const s = slots[k]!;
      return [s.v, (x: unknown) => { s.v = typeof x === "function" ? (x as (p: unknown) => unknown)(s.v) : x; }];
    },
    useReducer(reducer: (s: unknown, a: unknown) => unknown, init: unknown) {
      const k = i++;
      if (!slots[k]) slots[k] = { v: init };
      const s = slots[k]!;
      return [s.v, (a: unknown) => { s.v = reducer(s.v, a); }];
    },
    useRef(init: unknown) {
      const k = i++;
      if (!slots[k]) slots[k] = { current: init };
      return slots[k];
    },
    useCallback(f: unknown, d: unknown[]) {
      const k = i++;
      if (slots[k] && same(slots[k]!.d, d)) return slots[k]!.f;
      slots[k] = { f, d };
      return f;
    },
    useEffect(f: () => unknown, d: unknown[]) {
      const k = i++;
      const s = slots[k];
      if (s && same(s.d, d)) return;
      queue.push(() => {
        if (typeof s?.cleanup === "function") (s.cleanup as () => void)();
        slots[k] = { d, cleanup: f() };
      });
    },
    flush() {
      for (const q of queue.splice(0)) q();
    },
  };
}

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    const fromHome = context.parentURL?.endsWith("/components/robinhood/RobinhoodHome.tsx") ?? false;
    const fromAdapter = context.parentURL?.endsWith("/lib/robinhood/adapter.ts") ?? false;
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (fromHome && specifier === "react") {
      return stub(
        "const H = () => globalThis.__a6t;" +
        "export const useState = (i) => H().useState(i);" +
        "export const useReducer = (r, i) => H().useReducer(r, i);" +
        "export const useRef = (i) => H().useRef(i);" +
        "export const useCallback = (f, d) => H().useCallback(f, d);" +
        "export const useEffect = (f, d) => H().useEffect(f, d);",
      );
    }
    if (fromHome && specifier === "@/lib/robinhood/wallet") {
      return stub(
        "export const useEvmWallet = () => ({ address: globalThis.__a6tWallet, hasWallet: true });" +
        "export const robinhoodPublicClient = globalThis.__a6tClient;",
      );
    }
    if (fromAdapter && specifier === "./config") return stub("export const TRUSTED_FACTORY = globalThis.__a6tFactory;");
    if (fromHome && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ openConnect: () => {} });");
    if (fromHome && specifier === "@/components/othello/Shell") return stub("export default (p) => p.children;");
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    return next(specifier, context);
  },
});

type RpcItem = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
type RpcReply = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

describe("A6 adversary on 949f7dc: a refused listing page waits forever on a call whose body never arrives", function () {
  this.timeout(240_000);
  let anvil: ChildProcess;
  let relay: Server | undefined;
  let pub: PublicClient;
  const accounts = [0, 1, 2, 3].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let w0: WalletClient;

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    w0 = createWalletClient({ account: accounts[0]!, chain, transport: http(ANVIL) });
  });
  after(() => {
    anvil?.kill();
    relay?.closeAllConnections();
    relay?.close();
  });

  it("draws the list's error within the transport's bound when one call of the failed page never finishes", async () => {
    const usdg = await deploy(w0, artifact("MockUSDG.sol", "MockUSDG"));
    const factory = await deploy(w0, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    const { request } = await pub.simulateContract({
      address: factory, abi: othelloFactoryAbi as Abi, functionName: "createCircle", account: w0.account!,
      args: [
        { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
          roundSecs: 60n, graceSecs: 30n },
        accounts.slice(0, 3).map((a) => a.address),
      ],
    } as never);
    await pub.waitForTransactionReceipt({ hash: await w0.writeContract({ ...(request as object), chain } as never) });
    const A = getAddress(accounts[0]!.address);
    const page = (await pub.readContract({
      address: factory, abi: othelloFactoryAbi, functionName: "circlesOfPage", args: [A, 0n, 1n],
    } as never)) as readonly Address[];
    const circle = page[0]!.toLowerCase();
    const code = await pub.getCode({ address: factory });
    g.__a6tFactory = Object.freeze({ address: factory, codeHash: keccak256(code!) });

    const selN = encodeFunctionData({ abi: othelloCircleAbi as Abi, functionName: "n" }).slice(0, 10).toLowerCase();
    const selC = encodeFunctionData({ abi: othelloCircleAbi as Abi, functionName: "c" }).slice(0, 10).toLowerCase();
    const listingCall = (x: RpcItem, sel: string) => {
      if (x.method !== "eth_call") return false;
      const [tx, tag] = (x.params ?? []) as [{ to?: string; data?: string; input?: string } | undefined, unknown];
      const data = (tx?.data ?? tx?.input ?? "").toLowerCase();
      return tx?.to?.toLowerCase() === circle && data.startsWith(sel) && (tag === undefined || tag === "latest");
    };
    // the first listing "c" is answered "busy"; the request carrying viem's retry of it gets headers and no body
    let cSeen = 0;
    let stalled = 0;
    relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", async () => {
        const parsed = JSON.parse(body) as RpcItem | RpcItem[];
        const items = Array.isArray(parsed) ? parsed : [parsed];
        const cHere = items.some((x) => listingCall(x, selC));
        if (cHere) cSeen++;
        if (cHere && cSeen > 1) {
          stalled++;
          res.writeHead(200, { "content-type": "application/json" });
          res.flushHeaders();
          return;
        }
        const up = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body });
        const answered = (await up.json()) as RpcReply | RpcReply[];
        const replies = Array.isArray(answered) ? answered : [answered];
        const out = replies.map((r) => {
          const x = items.find((i) => i.id === r.id)!;
          if (listingCall(x, selN)) return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "injected: refused" } };
          if (listingCall(x, selC)) return { jsonrpc: "2.0", id: r.id, error: { code: -32603, message: "injected: busy" } };
          return r;
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(answered) ? out : out[0]));
      });
    });
    await new Promise<void>((r) => relay!.listen(RELAY_PORT, "127.0.0.1", () => r()));

    // the app's own client shape (lib/robinhood/wallet.ts): viem http with batching, viem's default timeout and retries
    g.__a6tClient = createPublicClient({ chain, transport: robinhoodHttp(RELAY) /* the app's own transport (lib/robinhood/transport.ts), as lib/robinhood/wallet.ts builds it */ });
    g.__a6tWallet = A;
    g.__a6t = hooks();
    const { useRobinhoodCircles } = await import(pathToFileURL(resolve(SRC, "components/robinhood/RobinhoodHome.tsx")).href);
    const h = g.__a6t!;
    const step = () => {
      h.begin();
      const s = useRobinhoodCircles();
      h.flush();
      return s;
    };

    // 90 s: viem's worst case for one call is 4 tries of its 10 s timeout plus 150 + 300 + 600 ms of backoff
    const started = Date.now();
    let source = step();
    while (!source.error && Date.now() - started < 90_000) {
      await sleep(250);
      source = step();
    }
    assert.ok(stalled >= 1, "precondition: viem retried the busy listing c read, and the relay held that request's body");
    assert.ok(source.error,
      `after ${Math.round((Date.now() - started) / 1000)} s the page whose "n" read was refused still draws no error ` +
      `and no Try again (found: ${source.found}): it is waiting on a call whose response body never arrives, which ` +
      `viem's timeout does not cover`);
    assert.equal(source.error, "Robinhood Chain testnet did not answer. Try again in a moment.");
    assert.ok(source.retry, "the list draws Try again");
  });
});
