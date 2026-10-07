/**
 * Adversary on 9343ef9 (readCircle pins every read to the latest block's HASH with requireCanonical and, when a read
 * fails while that block still stands, rethrows the read's own error).
 *
 * Rule: a readCircle error must not break the page; it keeps or recovers its view on the next 8 s read and shows
 * nothing sensitive (no RPC URL).
 *
 * Attack: a load-balanced RPC whose node answering eth_call is one block behind the node answering getBlock. The read
 * by hash gets "header not found" (the exact error the real Robinhood testnet RPC returns for a hash it does not know,
 * recorded 2026-10-06 from https://rpc.testnet.chain.robinhood.com: {"code":-32000,"message":"header not found"}).
 * The block stands, so readCircle rethrows viem's error unchanged. viem 2.56.8 puts "URL: <rpc url>" and
 * "Request body: {...}" in that message, and RobinhoodCircle.tsx shows it verbatim on a first read:
 * `Couldn't read the circle: ${readError}`.
 *
 * Harness: real contracts on a local anvil, a tiny HTTP proxy in front of it that models the lagging node, the real
 * readCircle through viem's http transport with batch: true (as app/src/lib/robinhood/wallet.ts), and the real page
 * under the minimal hook runner of tests/a5-page-clock-skew.spec.ts. Needs `forge build` in evm/.
 *
 * Fix pass on 9343ef9: readCircle steps one block back, then two, after a failed read, and the page shows a fixed
 * sentence for a read error. Failed on 9343ef9 (raw viem message with the URL and request body); passes now.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a5-read-error-rpc-url-adversary.spec.ts
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
  createPublicClient, createWalletClient, defineChain, http,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { REPO } from "./artifacts.ts";
import { readCircle as realReadCircle } from "../app/src/lib/robinhood/adapter-core.ts";
import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";

const PORT = 8623;
const PROXY_PORT = 8624;
const ANVIL = `http://127.0.0.1:${PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
const U = 1_000_000n;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

// ---------------------------------------------------------------- the minimal hook runner (a5-page-clock-skew.spec.ts)
const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "components/robinhood/RobinhoodCircle.tsx");
type El = { type: unknown; props: Record<string, unknown> };
type Effect = { deps?: unknown[]; cleanup?: () => void; pending?: () => void | (() => void) };
const mini = { slots: [] as unknown[], effects: [] as Effect[], i: 0, e: 0, render: null as null | (() => El), tree: null as El | null, scheduled: false };
const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
function rerender() {
  mini.scheduled = false;
  mini.i = 0;
  mini.e = 0;
  mini.tree = mini.render!();
  for (const ef of mini.effects) {
    if (ef.pending) {
      ef.cleanup?.();
      const out = ef.pending();
      ef.pending = undefined;
      ef.cleanup = typeof out === "function" ? out : undefined;
    }
  }
}
function schedule() {
  if (mini.scheduled) return;
  mini.scheduled = true;
  queueMicrotask(rerender);
}
const ReactStub = {
  useState<T>(init: T | (() => T)) {
    const k = mini.i++;
    if (!(k in mini.slots)) mini.slots[k] = typeof init === "function" ? (init as () => T)() : init;
    const set = (next: T | ((p: T) => T)) => {
      const val = typeof next === "function" ? (next as (p: T) => T)(mini.slots[k] as T) : next;
      if (!Object.is(val, mini.slots[k])) {
        mini.slots[k] = val;
        schedule();
      }
    };
    return [mini.slots[k] as T, set] as const;
  },
  useRef<T>(init: T) {
    const k = mini.i++;
    if (!(k in mini.slots)) mini.slots[k] = { current: init };
    return mini.slots[k] as { current: T };
  },
  useMemo<T>(fn: () => T, deps: unknown[]) {
    const k = mini.i++;
    const prev = mini.slots[k] as { deps: unknown[]; v: T } | undefined;
    if (!prev || changed(prev.deps, deps)) mini.slots[k] = { deps, v: fn() };
    return (mini.slots[k] as { v: T }).v;
  },
  useCallback<T>(fn: T, deps: unknown[]) {
    return ReactStub.useMemo(() => fn, deps);
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const k = mini.e++;
    const ef = (mini.effects[k] ??= {});
    if (changed(ef.deps, deps) || ef.deps === undefined) {
      ef.pending = fn;
      ef.deps = deps ?? [];
      if (deps === undefined) ef.deps = undefined;
    }
  },
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  Fragment: "fragment",
};
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
const io = { read: null as null | (() => Promise<unknown>), intervals: [] as { fn: () => void; ms: number }[] };
const g = globalThis as Record<string, unknown>;
g.__mini = ReactStub;
g.__jsx = jsx;
g.__io = io;
g.React = ReactStub;
g.window = { setInterval: (fn: () => void, ms: number) => io.intervals.push({ fn, ms }) - 1, clearInterval: () => {} };
const STUBS: Record<string, string> = {
  react: `const m = globalThis.__mini; export default m; export const { useState, useRef, useMemo, useCallback, useEffect, createElement, Fragment } = m;`,
  "react/jsx-runtime": `export const jsx = globalThis.__jsx, jsxs = globalThis.__jsx, Fragment = "fragment";`,
  "react/jsx-dev-runtime": `export const jsxDEV = globalThis.__jsx, Fragment = "fragment";`,
  "@/components/othello/Shell": `export default function Shell(p) { return { type: "shell", props: { children: p.children } }; }`,
  "@/lib/wallet": `export const useWalletUi = () => ({ openConnect() {} });`,
  "@/lib/robinhood/wallet": `
    export const robinhoodPublicClient = {};
    export const useEvmWallet = () => ({ hasWallet: false, address: null, walletClient: null, onRobinhood: true, error: null, switchToRobinhood() {} });`,
  // The trust check passes; the read is the REAL readCircle (adapter-core) over viem http to the lagging RPC.
  "@/lib/robinhood/adapter": `
    export const trustedFactory = null;
    export const topUpFill = (d, a) => (d < a ? d : a);
    export const checkTrusted = async () => ({ ok: true });
    export const readCircle = () => globalThis.__io.read();
    export function createRobinhoodAdapter() { return {}; }`,
};
registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier in STUBS) return stub(STUBS[specifier]!);
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
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
const text = (el: unknown): string =>
  el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el)
    : Array.isArray(el) ? el.map(text).join("") : text((el as El).props?.children);
const settle = async () => {
  for (let k = 0; k < 200; k++) await new Promise((r) => setTimeout(r, 1));
};

// ---------------------------------------------------------------- a load balancer whose eth_call node is one block behind
type Rpc = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
async function anvilRpc(body: unknown) {
  const res = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
let callNodeDown = false; // every eth_call fails (fix pass: a read that can never succeed)
async function lagging(req: Rpc) {
  const at = req.params?.[1] as { blockHash?: string } | undefined;
  if (req.method === "eth_call" && callNodeDown) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "header not found" } };
  if (req.method === "eth_call" && at && typeof at === "object" && at.blockHash) {
    const head = (await anvilRpc({ jsonrpc: "2.0", id: 0, method: "eth_getBlockByNumber", params: ["latest", false] })) as { result: { hash: string } };
    // the newest block is not yet known to this node; recorded verbatim from the real Robinhood testnet RPC
    if (head.result.hash === at.blockHash) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "header not found" } };
  }
  return anvilRpc(req);
}

describe("adversary 9343ef9: a read error reaches the page with the RPC URL and request body", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let proxy: Server;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let w: WalletClient;

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await sleep(100);
      }
    }
    w = createWalletClient({ account: accounts[0]!, chain, transport: http(ANVIL) });
    proxy = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", async () => {
        const body = JSON.parse(raw) as Rpc | Rpc[];
        const out = Array.isArray(body) ? await Promise.all(body.map(lagging)) : await lagging(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));
  });
  after(() => {
    proxy?.close();
    anvil?.kill();
  });

  it("a call node one block behind still gives a view; a read that cannot succeed shows a plain message, no RPC URL", async () => {
    const deploy = async (a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> => {
      const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    const usdg = await deploy(artifact("MockUSDG.sol", "MockUSDG"));
    const factory = await deploy(artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    const { request, result } = await pub.simulateContract({
      address: factory, abi: othelloFactoryAbi as Abi, functionName: "createCircle", account: w.account!,
      args: [
        { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n,
          roundSecs: 60n, graceSecs: 30n },
        accounts.map((a) => a.address),
      ],
    } as never);
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...(request as object), chain } as never) });
    const circle = result as Address;

    // precondition: straight to anvil, the read works
    const direct = await realReadCircle(pub, circle, usdg);
    assert.equal(direct.n, 3, "precondition: the circle reads directly");

    // the page's client shape: viem http with JSON-RPC batching (app/src/lib/robinhood/wallet.ts), via the balancer
    const page = createPublicClient({ chain, transport: http(PROXY, { batch: true }) });
    const mod = await import(pathToFileURL(PAGE).href);

    // the circle is one block old when the page opens (on a real chain, many)
    await anvilRpc({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] });
    // Fix pass: readCircle steps one block back after a failed read, so the lagging node answers, from one block.
    const head = await pub.getBlock({ blockTag: "latest" });
    const parent = await pub.getBlock({ blockNumber: head.number! - 1n });
    const lagged = await realReadCircle(page, circle, usdg);
    assert.equal(lagged.chainTime, Number(parent.timestamp), "the view is the block one behind, time and state alike");
    assert.equal(lagged.n, 3);
    io.read = () => realReadCircle(page, circle, usdg);
    mini.render = () => mod.default({ address: circle });
    rerender();
    await settle();
    assert.doesNotMatch(text(mini.tree), /Couldn't read the circle/, "a node one block behind still gives the page a view");

    // A read that can never succeed (every eth_call fails): the page says so plainly, with nothing of the RPC's own.
    callNodeDown = true;
    let rejected: Error | null = null;
    io.read = () => realReadCircle(page, circle, usdg).catch((e: Error) => { rejected = e; throw e; });
    mini.slots = []; mini.effects = []; mini.tree = null; io.intervals = [];
    rerender();
    // readCircle now waits before each retry (400 ms, then 800 ms: the public RPC rate-limits bursts), so the read
    // takes over a second to give up; wait for it to, then let the page settle
    for (let k = 0; k < 100 && !rejected; k++) await new Promise((r) => setTimeout(r, 50));
    await settle();

    assert.ok(rejected, "precondition: the failing call node made readCircle fail");
    assert.match(String((rejected as Error).cause), /header not found/, "the RPC's error is kept as the cause, for the console");
    const shown = text(mini.tree);
    assert.match(shown, /Couldn't read the circle/, "precondition: the page shows its read error");
    assert.doesNotMatch(shown, /127\.0\.0\.1:8624|URL:|Request body|header not found|Missing or invalid/,
      `the page shows the RPC's raw error to the user:\n${shown}`);
  });
});
