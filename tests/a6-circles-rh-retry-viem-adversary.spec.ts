/**
 * A6 adversary on bdc3a1c (PR #25, the shared circles list). Spec item 1: "After Try again, Show more, a wallet
 * switch or a page leave, no listing call for an earlier attempt starts, and nothing from it is drawn or acted on."
 *
 * useRobinhoodCircles (app/src/components/robinhood/RobinhoodHome.tsx) now gives each load its own attempt number and
 * hands listMyCircles `() => !current()`, which listCirclesPageWith (lib/robinhood/adapter-core.ts) asks between its
 * rounds. But inside a round, summarize's first five reads (n, c, status, round, creator) run under Promise.all: when
 * one fails, the page rejects and the error with its Try again is drawn while the round's other reads are still on
 * the transport. viem's http transport retries a read that the RPC answers with a retryable error (-32603, 429,
 * -32005: a rate-limited RPC) after its own backoff, and no stale check reaches that retry. So a read for the failed
 * attempt starts again after Try again has started the next one, beside the new attempt's reads. readCircle already
 * guards the same shape with allSettledOrThrow (adversary on cbdba79); the listing page does not.
 *
 * Harness: real MockUSDG and OthelloFactory on a local anvil (chain 46630); wallet A creates one circle with
 * createCircle; TRUSTED_FACTORY points at the anvil factory with its real code hash; the real useRobinhoodCircles,
 * run by the hook runner of tests/a6-circles-rh-retry-stale-adversary.spec.ts, reads through a real viem http client
 * (batch on, as in lib/robinhood/wallet.ts) pointed at a local JSON-RPC relay in front of anvil. Before Try again the
 * relay answers the circle's listing "n" read with a non-retryable error (-32000) and its "c" read with -32603 (as a
 * rate-limited RPC would); from Try again on it relays everything unchanged. It counts every listing "c" request for
 * the circle (eth_call at "latest": readCircle's reads are pinned to a block hash) that reaches it after Try again.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-rh-retry-viem-adversary.spec.ts
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
import { mnemonicToAccount } from "viem/accounts";

import { REPO } from "./artifacts.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";

const SRC = resolve(REPO, "app/src");
const PORT = 8697;
const RELAY_PORT = 8698;
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

describe("A6 adversary on bdc3a1c: a failed listing attempt's transport retry starts after Try again", function () {
  this.timeout(180_000);
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
    relay?.close();
  });

  it("starts no listing read for the failed attempt once Try again has started the next one", async () => {
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
    // before Try again the relay refuses the circle's listing n and c reads; from Try again on it relays everything
    let afterRetry = false;
    let cBefore = 0;
    let cAfter = 0;
    const listingCall = (x: RpcItem, sel: string) => {
      if (x.method !== "eth_call") return false;
      const [tx, tag] = (x.params ?? []) as [{ to?: string; data?: string; input?: string } | undefined, unknown];
      const data = (tx?.data ?? tx?.input ?? "").toLowerCase();
      return tx?.to?.toLowerCase() === circle && data.startsWith(sel) && (tag === undefined || tag === "latest");
    };
    relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", async () => {
        const parsed = JSON.parse(body) as RpcItem | RpcItem[];
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const x of items) if (listingCall(x, selC)) { if (afterRetry) cAfter++; else cBefore++; }
        const refuse = !afterRetry;
        const up = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body });
        const answered = (await up.json()) as RpcReply | RpcReply[];
        const replies = Array.isArray(answered) ? answered : [answered];
        const out = replies.map((r) => {
          const x = items.find((i) => i.id === r.id)!;
          if (refuse && listingCall(x, selN)) return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "injected: refused" } };
          if (refuse && listingCall(x, selC)) return { jsonrpc: "2.0", id: r.id, error: { code: -32603, message: "injected: busy" } };
          return r;
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(answered) ? out : out[0]));
      });
    });
    await new Promise<void>((r) => relay!.listen(RELAY_PORT, "127.0.0.1", () => r()));

    // the app's own client shape (lib/robinhood/wallet.ts): viem http with batching and viem's default retries
    g.__a6tClient = createPublicClient({ chain, transport: http(RELAY, { batch: true }) });
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

    let source = step();
    for (let k = 0; k < 4000 && !source.error; k++) {
      await sleep(5);
      source = step();
    }
    assert.ok(source.error, "precondition: the first attempt fails and the list draws its error");
    assert.ok(source.retry, "precondition: the list draws Try again");
    assert.ok(cBefore >= 1, "precondition: the first attempt sent the circle's listing c read");

    // the user presses Try again as soon as it is drawn
    afterRetry = true;
    source.retry();
    for (let k = 0; k < 200 && !(source.found === 1 && source.reading === 0); k++) {
      await sleep(50);
      source = step();
    }
    assert.equal(source.found, 1, "precondition: the attempt started by Try again lists the circle");
    await sleep(2_000);

    // the attempt Try again started sends one listing c read; anything more was started for the failed attempt
    assert.equal(cAfter, 1,
      `after Try again, ${cAfter} listing "c" reads for the circle reached the RPC; the new attempt sends 1, ` +
      `so ${cAfter - 1} were started for the failed attempt (viem's retry of its refused read)`);
  });
});
