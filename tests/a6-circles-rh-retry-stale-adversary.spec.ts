/**
 * A6 adversary on ac23c88 (PR #25, the shared circles list). Spec item 1: "After a wallet switch, a page leave or a
 * Try again, no listing or circle-read call for the old state starts, and nothing read for it is drawn or acted on."
 *
 * useRobinhoodCircles (app/src/components/robinhood/RobinhoodHome.tsx) now hands listMyCircles the stale check
 * `() => id !== req.current`, and listCirclesPageWith (lib/robinhood/adapter-core.ts) asks it between its rounds and
 * inside summarize, before each circle's seat reads. But the list's "Try again" (`source.retry`, drawn beside
 * "Couldn't read your circles") calls load() again without moving req.current, so the attempt it replaces never turns
 * stale. One page's summaries run side by side under Promise.all: when one circle's read fails, the page rejects and
 * the error is drawn, while the other circles' first rounds are still on the wire. After Try again, each of those
 * still passes its check and starts its seat reads ("members") for the failed attempt, beside the new attempt's own,
 * on the rate-limited public RPC.
 *
 * Harness: real MockUSDG and OthelloFactory on a local anvil (chain 46630); wallet A creates two circles with
 * createCircle; TRUSTED_FACTORY points at the anvil factory with its real code hash; the real useRobinhoodCircles run
 * by the hook runner of tests/a6-circles-rh-switch-more-adversary.spec.ts. Two injected faults, on the first attempt
 * only: the older circle's "n" read fails (as an RPC error would), and the newer circle's first-round reads are held
 * until after Try again (as a slow RPC would hold them). Listing reads are told apart from the full circle reads by
 * the blockHash every readCircle call is pinned to.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-rh-retry-stale-adversary.spec.ts
 * Hook-installing spec: run it in its own process.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { REPO } from "./artifacts.ts";
import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";

const SRC = resolve(REPO, "app/src");
const PORT = 8693;
const ANVIL = `http://127.0.0.1:${PORT}`;
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

describe("A6 adversary on ac23c88: the /robinhood list's Try again leaves the failed attempt's reads running", function () {
  this.timeout(180_000);
  let anvil: ChildProcess;
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
  });

  it("starts no seat read for the failed attempt once Try again has started the next one", async () => {
    const usdg = await deploy(w0, artifact("MockUSDG.sol", "MockUSDG"));
    const factory = await deploy(w0, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    for (let k = 0; k < 2; k++) {
      const { request } = await pub.simulateContract({
        address: factory, abi: othelloFactoryAbi as Abi, functionName: "createCircle", account: w0.account!,
        args: [
          { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
            roundSecs: 60n, graceSecs: 30n },
          accounts.slice(0, 3).map((a) => a.address),
        ],
      } as never);
      await pub.waitForTransactionReceipt({ hash: await w0.writeContract({ ...(request as object), chain } as never) });
    }
    const A = getAddress(accounts[0]!.address);
    const page = (await pub.readContract({
      address: factory, abi: othelloFactoryAbi, functionName: "circlesOfPage", args: [A, 0n, 2n],
    } as never)) as readonly Address[];
    const older = getAddress(page[0]!);
    const newer = getAddress(page[1]!);
    const code = await pub.getCode({ address: factory });
    g.__a6tFactory = Object.freeze({ address: factory, codeHash: keccak256(code!) });

    // every listing read (no blockHash: summarize's, not readCircle's), with the attempt it was sent in
    let attempt = 1;
    const listing: { attempt: number; fn: string; to: Address }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let failedOnce = false;
    const real = createPublicClient({ chain, transport: http(ANVIL, { batch: true }) });
    g.__a6tClient = new Proxy(real, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (key !== "readContract" || typeof v !== "function") return v;
        return async (args: { functionName: string; address: Address; blockHash?: Hex }) => {
          const to = getAddress(args.address);
          if (args.blockHash === undefined && (to === older || to === newer)) {
            const at = attempt;
            listing.push({ attempt: at, fn: args.functionName, to });
            if (at === 1 && to === older && args.functionName === "n" && !failedOnce) {
              failedOnce = true;
              throw new Error("injected: the RPC refused this call");
            }
            if (at === 1 && to === newer) await gate;
          }
          return (v as (a: unknown) => unknown).call(target, args);
        };
      },
    });
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
    for (let k = 0; k < 100 && !source.error; k++) {
      await sleep(100);
      source = step();
    }
    assert.ok(source.error, "precondition: the first attempt fails and the list draws its error");
    assert.ok(source.retry, "precondition: the list draws Try again");
    assert.ok(
      listing.some((c) => c.attempt === 1 && c.to === newer && c.fn === "n"),
      "precondition: the newer circle's first-round reads were sent by the first attempt",
    );

    // the user presses Try again; then the slow first-round answers of the failed attempt arrive
    attempt = 2;
    source.retry();
    release();
    for (let k = 0; k < 100 && !(source.found === 2 && source.reading === 0); k++) {
      await sleep(100);
      source = step();
    }
    assert.equal(source.found, 2, "precondition: the attempt started by Try again lists both circles");
    await sleep(1_000);

    // the attempt Try again started reads each circle's 3 seats once; anything more is the failed attempt's
    const seatReads = listing.filter((c) => c.attempt === 2 && c.fn === "members" && c.to === newer).length;
    assert.equal(seatReads, 3,
      `after Try again, ${seatReads} seat reads ("members") went out for the newer circle; the new attempt needs 3, ` +
      `so ${seatReads - 3} were started for the failed attempt`);
  });
});
