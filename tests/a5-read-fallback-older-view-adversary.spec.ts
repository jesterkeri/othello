/**
 * Adversary on de3c654 (readCircle, after a failed read at the newest block, reads again one block back, then two;
 * the page sets whatever view readCircle returns).
 *
 * Rule (brief for de3c654): "A view from an older block must never make the page show a state newer than the chain's
 * (e.g. a later view replaced by an older one across refreshes, so a released pot or a payment appears to un-happen,
 * or a round goes backwards)."
 *
 * Attack: the page has already shown block N+1 (the creator cancelled the circle there). On the next 8 s read the
 * load balancer sends eth_call to a node one block behind ("header not found" for N+1's hash, recorded from the real
 * Robinhood testnet RPC, see tests/a5-read-error-rpc-url-adversary.spec.ts). No new block has been made (anvil, like
 * an Arbitrum sequencer, makes a block only for a transaction). readCircle falls back to block N, where the circle is
 * still Forming, and RobinhoodCircle.tsx replaces its newer view with it: the cancellation un-happens on screen.
 *
 * Harness: the one of tests/a5-read-error-rpc-url-adversary.spec.ts (anvil, a lagging-node proxy, the real readCircle
 * over viem http with batch: true, the real page under the minimal hook runner). Needs `forge build` in evm/.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a5-read-fallback-older-view-adversary.spec.ts
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

const PORT = 8631;
const PROXY_PORT = 8632;
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
    : Array.isArray(el) ? el.map(text).join("")
    // as find: the shared circle page's named props (payout, closeOut, act, banners, ...) are part of the page's text
    : (el as El).props ? [(el as El).props.children, ...Object.entries((el as El).props).filter(([k, v]) => k !== "children" && v && typeof v === "object").map(([, v]) => v)].map(text).join("")
    : typeof el === "object" ? Object.values(el as object).map(text).join(" ") : "";
const settle = async () => {
  for (let k = 0; k < 200; k++) await new Promise((r) => setTimeout(r, 1));
};

// ---------------------------------------------------------------- a load balancer whose eth_call node is one block behind
type Rpc = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
async function anvilRpc(body: unknown) {
  const res = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
let lag = false; // the call node is one block behind the newest block
async function lagging(req: Rpc) {
  const at = req.params?.[1] as { blockHash?: string } | undefined;
  if (lag && req.method === "eth_call" && at && typeof at === "object" && at.blockHash) {
    const head = (await anvilRpc({ jsonrpc: "2.0", id: 0, method: "eth_getBlockByNumber", params: ["latest", false] })) as { result: { hash: string } };
    // the newest block is not yet known to this node; recorded verbatim from the real Robinhood testnet RPC
    if (head.result.hash === at.blockHash) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "header not found" } };
  }
  return anvilRpc(req);
}

describe("adversary de3c654: a fallback read one block back replaces a newer view on the page", function () {
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

  it("a cancellation the page has shown does not un-happen when the next read lands on a lagging call node", async () => {
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
    const circleAbi = artifact("OthelloCircle.sol", "OthelloCircle").abi;

    const page = createPublicClient({ chain, transport: http(PROXY, { batch: true }) });
    const mod = await import(pathToFileURL(PAGE).href);
    let shownAt: number[] = [];
    io.read = () => realReadCircle(page, circle, usdg).then((v) => { shownAt.push(v.chainTime); return v; });
    mini.render = () => mod.default({ address: circle });
    rerender();
    await settle();
    // the status pill: once the first thing in the page's text, now the shared circle page's `status` prop
    assert.equal((mini.tree as El).props.status, "Forming", `precondition: the page shows the Forming circle:\n${text(mini.tree).slice(0, 400)}`);

    // block N+1: the creator cancels the circle; the next 8 s read shows it
    await anvilRpc({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [5] });
    const tx = await w.writeContract({ address: circle, abi: circleAbi, functionName: "cancelCircle", account: w.account!, chain });
    await pub.waitForTransactionReceipt({ hash: tx });
    const tick = io.intervals.find((x) => x.ms === 8_000)!;
    tick.fn();
    await settle();
    assert.equal((mini.tree as El).props.status, "Cancelled", `precondition: the page shows the cancellation at N+1:\n${text(mini.tree).slice(0, 400)}`);

    // The next 8 s read: no new block yet, and eth_call lands on a node one block behind.
    lag = true;
    shownAt = [];
    tick.fn();
    await settle();
    const shown = text(mini.tree);
    // the status pill (the shared circle page's `status` prop) still says Cancelled
    assert.equal((mini.tree as El).props.status, "Cancelled",
      `the page replaced its view of block N+1 with an older one (chainTime ${shownAt.join(", ")}): the cancellation ` +
      `un-happened on screen and the circle reads as Forming again:\n${shown.slice(0, 300)}`);
  });
});
