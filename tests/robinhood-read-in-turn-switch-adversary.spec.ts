/**
 * Adversary on afa5aaa (PR #25, circle reads one at a time). Spec 3: "After a wallet switch nothing read for the
 * previous wallet is drawn or acted on, including reads still waiting in the queue: they must not delay the new
 * wallet's reads unboundedly, nor land in its views."
 *
 * readCircleInTurn (app/src/lib/robinhood/adapter-core.ts) chains every read onto one module-wide promise and has no
 * way to drop a read that is still waiting. useRobinhoodCircles (app/src/components/robinhood/RobinhoodHome.tsx) only
 * discards a stale read's RESULT (`id === req.current`), after the read has run. So after a switch the new wallet's
 * first circle read waits behind every read still queued for the previous wallet, and each switch back and forth
 * queues a whole page more: the wait grows with the number of switches, with no bound.
 *
 * Attack: wallet A has 10 circles (one page), wallet B has 1. The page switches A, B, A, B, A, B, each time as soon
 * as that wallet's list has been found and its circle reads queued. Harness: real OthelloFactory and MockUSDG on a
 * local anvil (chain 46630), the real adapter through a viem http client with batch: true, whose getBlock answers
 * after 120 ms (the public RPC is slow under load, and this is the call each circle read starts with); the real
 * useRobinhoodCircles run by the same small hook runner as tests/a6-circles-rh-switch-more-adversary.spec.ts.
 * Each circle read is seen once, at its pinned `creator` call (only readCircleAt reads `creator` at a block hash).
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-read-in-turn-switch-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  createPublicClient, createWalletClient, defineChain, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { REPO } from "./artifacts.ts";
import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { USDG } from "../app/src/lib/robinhood/chain.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));
const PORT = 8733;
const ANVIL = `http://127.0.0.1:${PORT}`;
const U = 1_000_000n;
const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex; runtime: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, runtime: j.deployedBytecode.object };
}

type Slot = { v?: unknown; current?: unknown; f?: unknown; d?: unknown[]; cleanup?: unknown };
const g = globalThis as {
  __a6r?: ReturnType<typeof hooks>; __a6rWallet?: string; __a6rClient?: unknown; __a6rFactory?: unknown;
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
        "const H = () => globalThis.__a6r;" +
        "export const useState = (i) => H().useState(i);" +
        "export const useReducer = (r, i) => H().useReducer(r, i);" +
        "export const useRef = (i) => H().useRef(i);" +
        "export const useCallback = (f, d) => H().useCallback(f, d);" +
        "export const useEffect = (f, d) => H().useEffect(f, d);",
      );
    }
    // the wallet module: the connected address, and the public client (the app's, but on the local anvil)
    if (fromHome && specifier === "@/lib/robinhood/wallet") {
      return stub(
        "export const useEvmWallet = () => ({ address: globalThis.__a6rWallet, hasWallet: true });" +
        "export const robinhoodPublicClient = globalThis.__a6rClient;",
      );
    }
    // the trusted factory: the one deployed on the local anvil, with its real code hash
    if (fromAdapter && specifier === "./config") return stub("export const TRUSTED_FACTORY = globalThis.__a6rFactory;");
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

describe("adversary afa5aaa: reads queued for the last wallet hold up the new wallet's reads", function () {
  this.timeout(240_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2, 3, 4, 5].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...(request as object), chain } as never) });
    return result as unknown;
  }
  const params = {
    n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
    roundSecs: 60n, graceSecs: 30n,
  };

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(ANVIL) }));
  });
  after(() => {
    anvil?.kill();
  });

  it("starts wallet B's circle read after at most the one read already in flight for wallet A", async () => {
    // readCircle reads balances from the app's USDG address: MockUSDG's code is placed there on the local anvil
    await pub.request({ method: "anvil_setCode", params: [USDG, artifact("MockUSDG.sol", "MockUSDG").runtime] } as never);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [USDG]);
    // wallet A: 10 circles (one page); wallet B: 1 circle with members A never shares
    for (let k = 0; k < 10; k++) {
      await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [params, accounts.slice(0, 3).map((a) => a.address)]);
    }
    await write(wallets[3]!, factory, othelloFactoryAbi as Abi, "createCircle", [params, accounts.slice(3, 6).map((a) => a.address)]);
    const code = await pub.getCode({ address: factory });
    g.__a6rFactory = Object.freeze({ address: factory, codeHash: keccak256(code!) });

    // the app's client shape on the local anvil; getBlock (the first call of every circle read) answers after 120 ms
    const real = createPublicClient({ chain, transport: http(undefined, { batch: true }) });
    const events: ({ kind: "read"; circle: string } | { kind: "switch"; to: string })[] = [];
    g.__a6rClient = new Proxy(real, {
      get(target, key, recv) {
        if (key === "getBlock") {
          return async (args: never) => { await sleep(120); return target.getBlock(args); };
        }
        if (key === "readContract") {
          return (args: { address: string; functionName: string; blockHash?: string }) => {
            if (args.functionName === "creator" && args.blockHash) events.push({ kind: "read", circle: args.address.toLowerCase() });
            return target.readContract(args as never);
          };
        }
        return Reflect.get(target, key, recv);
      },
    });

    const A = accounts[0]!.address;
    const B = accounts[3]!.address;
    g.__a6r = hooks();
    const { useRobinhoodCircles } = await import(pathToFileURL(resolve(SRC, "components/robinhood/RobinhoodHome.tsx")).href);
    const h = g.__a6r!;
    const step = () => {
      h.begin();
      const s = useRobinhoodCircles();
      h.flush();
      return s;
    };
    // connect `who` and step until its list is found and its circle reads have been queued (one more step flushes
    // the read effect that runs on the found list)
    const connect = async (who: Address, found: number) => {
      g.__a6rWallet = who;
      events.push({ kind: "switch", to: who.toLowerCase() });
      let source = step();
      for (let k = 0; k < 200 && source.found !== found; k++) {
        await sleep(20);
        source = step();
      }
      assert.equal(source.found, found, `precondition: ${who} lists ${found} circle(s)`);
      return step();
    };

    await connect(A, 10);
    // let A's first read begin, as on a real page where the list draws and reads start
    for (let k = 0; k < 100 && !events.some((e) => e.kind === "read"); k++) await sleep(20);
    // switch back and forth: A, B, A, B, A, B
    await connect(B, 1);
    await connect(A, 10);
    await connect(B, 1);
    await connect(A, 10);
    const t0 = Date.now();
    let source = await connect(B, 1);
    for (let k = 0; k < 1500 && source.circles.length === 0 && source.failed.length === 0; k++) {
      await sleep(20);
      source = step();
    }
    const waited = Date.now() - t0;
    assert.equal(source.circles.length, 1, "precondition: wallet B's one circle is read in the end");
    const bCircle = source.circles[0]!.address.toLowerCase();

    const aCircles = new Set(events.flatMap((e) => (e.kind === "read" && e.circle !== bCircle ? [e.circle] : [])));
    assert.ok(aCircles.size >= 1, "precondition: a read for wallet A had started before the first switch");
    // the read whose view B's card shows is the last one started for B's circle (earlier ones were queued by the
    // earlier switches to B, and their replies are dropped by the page as stale)
    const lastSwitch = events.map((e) => e.kind === "switch").lastIndexOf(true);
    const after = events.slice(lastSwitch + 1);
    const shownAt = after.map((e) => e.kind === "read" && e.circle === bCircle).lastIndexOf(true);
    assert.ok(shownAt >= 0, "precondition: B's circle read started after the last switch");
    const stale = after.slice(0, shownAt).filter((e) => e.kind === "read");
    const staleA = stale.filter((e) => e.kind === "read" && e.circle !== bCircle).length;

    assert.ok(
      stale.length <= 1,
      `after the last switch to wallet B, ${stale.length} circle reads queued for earlier switches (${staleA} for ` +
        `wallet A, no longer shown) ran before the read B's card shows; B's card waited ${waited} ms. Each switch ` +
        "back and forth queued another full page, so the wait grows with every switch.",
    );
  });
});
