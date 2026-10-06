/**
 * A6 adversary on b37ba45 (PR #25, the shared circles list). Spec 5: "after a wallet switch nothing read for the
 * previous wallet is drawn, not even for one render."
 *
 * useRobinhoodCircles (app/src/components/robinhood/RobinhoodHome.tsx) gates `found`, `circles`, `reading`, `failed`
 * and `error` on `fresh` (the list was started for this wallet), but `more` is
 * `w.address && hasMore(list) ? {...} : null`, read from the reducer state the last wallet's list left behind. So on
 * the render right after a switch, before the reset effect runs, the shared CirclesHome
 * (app/src/components/circles/CirclesHome.tsx) draws "Show more" for the new wallet because the old wallet had more
 * than one page, and that button would ask for the new wallet's circles below the old wallet's `before`.
 *
 * Attack: wallet A creates 11 circles (one more than MY_CIRCLES_PAGE), so its first page leaves `before` set; then the
 * connected wallet switches to B, which has no circles at all. Harness: real OthelloFactory and MockUSDG on a local
 * anvil (chain 46630), the real adapter through a viem http client with batch: true, TRUSTED_FACTORY pointed at the
 * anvil factory and its real code hash, the real useRobinhoodCircles run by the same small hook runner as
 * tests/a6-circles-rh-error-url-adversary.spec.ts (react swapped for it), and the real CirclesHome rendered with
 * react-dom/server from the source of that first render after the switch (effects not yet flushed).
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-rh-switch-more-adversary.spec.ts
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

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));
const PORT = 8681;
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

describe("A6 adversary: after a Robinhood wallet switch the last wallet's Show more is drawn", function () {
  this.timeout(180_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2, 3].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
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

  it("draws nothing from wallet A's list on the first render for wallet B", async () => {
    const usdg = await deploy(wallets[0]!, artifact("MockUSDG.sol", "MockUSDG"));
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    // wallet A creates 11 circles: one more than a page (MY_CIRCLES_PAGE = 10), so its list has an older page
    for (let k = 0; k < 11; k++) {
      await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
        { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
          roundSecs: 60n, graceSecs: 30n },
        accounts.slice(0, 3).map((a) => a.address),
      ]);
    }
    const code = await pub.getCode({ address: factory });
    g.__a6rFactory = Object.freeze({ address: factory, codeHash: keccak256(code!) });
    g.__a6rClient = createPublicClient({ chain, transport: http(undefined, { batch: true }) });
    const A = accounts[0]!.address;
    const B = accounts[3]!.address;
    g.__a6rWallet = A;
    g.__a6r = hooks();

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
    for (let k = 0; k < 150 && !(source.found === 10 && source.more && !source.more.loading && source.reading === 0); k++) {
      await sleep(100);
      source = step();
    }
    assert.equal(source.found, 10, "precondition: wallet A's first page lists 10 of its 11 circles");
    assert.ok(source.more, "precondition: wallet A has an older page (Show more)");

    // the wallet switches to B, which never created or joined a circle; the first render, before its effects run
    g.__a6rWallet = B;
    h.begin();
    const first = useRobinhoodCircles();
    const firstHtml: string = renderToStaticMarkup(React.createElement(CirclesHome, { source: first }));
    h.flush();

    // B's own list, once read: no circles, so no older page
    let settled = step();
    for (let k = 0; k < 100 && settled.found === null; k++) {
      await sleep(100);
      settled = step();
    }
    assert.equal(settled.found, 0, "precondition: wallet B has no circles in the factory's index");
    assert.equal(settled.more, null, "precondition: wallet B's own list has no Show more");

    assert.equal(first.wallet.address, B, "precondition: the first render after the switch is for wallet B");
    assert.ok(!firstHtml.includes("Show more"),
      `the first render for wallet B draws wallet A's "Show more" (source.more is ${first.more ? "set" : "null"}): ${firstHtml.slice(0, 600)}`);
  });
});
