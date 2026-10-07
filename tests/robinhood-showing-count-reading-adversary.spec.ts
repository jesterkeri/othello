/**
 * Adversary on 6941dff (PR #25). Spec 3: "Nothing on either page states something about the wallet's circles that a
 * pending, failed, capped or not-yet-paged read could make untrue, on Robinhood or Solana; when every circle is read,
 * every count is exact again."
 *
 * 6941dff passes the Robinhood list's older index entries as `notShown` (list.before), and CirclesHome then prints
 * "Showing {circles + failed} of {circles + failed + notShown} circles". Circles still reading are in neither
 * `circles` nor `failed`, so while the first page's reads are pending the line states a total that leaves them out.
 *
 * Attack: the wallet creates eleven circles on the real OthelloFactory (the first page holds the ten newest, one older
 * waits behind Show more). The page-wide circle-read queue is held by one read of our own that waits on a gate, so the
 * ten listed reads are still pending when the page is drawn. Harness as tests/robinhood-older-page-unread-adversary.spec.ts:
 * local anvil (chain 46630), the real adapter through a viem http client with batch: true, the real useRobinhoodCircles
 * run by a small hook runner, and the real CirclesHome rendered with react-dom/server.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-showing-count-reading-adversary.spec.ts
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
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { USDG } from "../app/src/lib/robinhood/chain.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));
const PORT = 8867;
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
  __a6r?: ReturnType<typeof hooks>; __a6rWallet?: string; __a6rClient?: unknown; __a6rFactory?: unknown; React?: unknown;
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

describe("Adversary on 6941dff: the 'Showing N of M circles' line while the listed circles are still reading", function () {
  this.timeout(180_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let html = "";
  let release: () => void = () => {};
  let held: Promise<unknown> = Promise.resolve();

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...(request as object), chain } as never) });
    return result as unknown;
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(ANVIL) }));

    await pub.request({ method: "anvil_setCode", params: [USDG, artifact("MockUSDG.sol", "MockUSDG").runtime] } as never);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [USDG]);
    const params = { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
      roundSecs: 60n, graceSecs: 30n };
    const members = accounts.map((a) => a.address);
    // eleven circles created by the wallet: the chain's own count of its circles is 11
    for (let k = 0; k < 11; k++) await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [params, members]);
    const total = await pub.readContract({ address: factory, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [accounts[0]!.address] });
    assert.equal(total, 11n, "precondition: the factory lists eleven circles for the wallet");

    const code = await pub.getCode({ address: factory });
    g.__a6rFactory = Object.freeze({ address: factory, codeHash: keccak256(code!) });
    g.__a6rClient = createPublicClient({ chain, transport: http(undefined, { batch: true }) });
    g.__a6rWallet = accounts[0]!.address;
    g.__a6r = hooks();

    // hold the page-wide circle-read queue: one read whose getBlock waits on a gate, so every read queued behind it is
    // still pending when the page is drawn (as on the public RPC, where each read takes a second or more)
    const { readCircleInTurn } = await import(pathToFileURL(resolve(SRC, "lib/robinhood/adapter-core.ts")).href);
    let open = false;
    const gate = new Promise<void>((r) => { release = () => { open = true; r(); }; });
    const blocker = {
      getBlock: async () => { await gate; throw new Error("gate released"); },
      readContract: async () => { throw new Error("not reached"); },
    };
    held = readCircleInTurn(blocker, accounts[1]!.address, () => open).catch(() => undefined);

    const React = appRequire("react");
    g.React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { useRobinhoodCircles } = await import(pathToFileURL(resolve(SRC, "components/robinhood/RobinhoodHome.tsx")).href);
    const { default: CirclesHome } = await import(pathToFileURL(resolve(SRC, "components/circles/CirclesHome.tsx")).href);
    const h = g.__a6r!;
    const step = () => {
      h.begin();
      const s = useRobinhoodCircles();
      h.flush();
      return s;
    };
    let source = step();
    // the factory check and the first page; the circle reads stay queued behind the held read
    for (let k = 0; k < 600 && source.found !== 10; k++) {
      await sleep(100);
      source = step();
    }
    await sleep(300);
    source = step();
    assert.ok(source.blocked === null && !source.error, `precondition: the factory check and the list read passed (${String(source.error)})`);
    assert.equal(source.found, 10, "precondition: the first page lists the ten newest circles");
    assert.equal(source.reading, 10, "precondition: all ten listed circles are still reading (queue held)");
    assert.ok(source.more, "precondition: an older circle exists (Show more)");

    html = renderToStaticMarkup(React.createElement(CirclesHome, { source }));
  });
  after(async () => {
    release();
    await held;
    anvil?.kill();
  });

  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("never states a total of circles smaller than the wallet's eleven while ten of them are still reading", () => {
    const said = text(html);
    const m = said.match(/Showing (\d+) of (\d+) circles/);
    if (!m) return; // no count claimed: nothing untrue
    assert.equal(Number(m[2]), 11,
      `the page says "${m[0]}" while the factory lists 11 circles for this wallet (10 still reading, 1 behind Show more)`);
  });
});
