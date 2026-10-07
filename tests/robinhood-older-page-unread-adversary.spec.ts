/**
 * Adversary on 774ca7d (PR #25). Spec 3: "Nothing on either page states something about the wallet's circles that a
 * pending, failed or capped read could make untrue, on Robinhood or Solana; when every circle is read, every count is
 * exact again."
 *
 * The Robinhood list reads a wallet's circles a page at a time (MY_CIRCLES_PAGE = 10, newest first); older ones wait
 * behind "Show more" and are never read until it is pressed. useRobinhoodCircles (app/src/components/robinhood/
 * RobinhoodHome.tsx) passes no `notShown` for them, so CirclesHome's `unread` (reading + failed + notShown) is 0 once
 * the first page is read, and the board makes its exact claims: the pill "All caught up", the empty tile "No circles
 * running right now", the finished pile "10 circles paid out or cancelled" with no "+".
 *
 * Attack: the wallet creates one circle that waits on it (Forming, its own seat not joined: a Join), then creates and
 * cancels ten more on the real OthelloFactory. The waiting circle is the eleventh newest, so it sits on the second page.
 * Every read succeeds. Harness as tests/robinhood-needs-count-unread-adversary.spec.ts: local anvil (chain 46630), the
 * real adapter through a viem http client with batch: true, the real useRobinhoodCircles run by a small hook runner, and
 * the real CirclesHome rendered with react-dom/server.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-older-page-unread-adversary.spec.ts
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
const PORT = 8861;
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

describe("Adversary on 774ca7d: circles on an older page, never read, are counted as if there were none", function () {
  this.timeout(180_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let html = "";

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

    // readCircle reads balances from the app's USDG address: MockUSDG's code is placed there on the local anvil
    await pub.request({ method: "anvil_setCode", params: [USDG, artifact("MockUSDG.sol", "MockUSDG").runtime] } as never);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [USDG]);
    const params = { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
      roundSecs: 60n, graceSecs: 30n };
    const members = accounts.map((a) => a.address);
    // the oldest: a circle the wallet created and has not joined, so on chain it waits on the wallet (Join)
    const waiting = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [params, members])) as Address;
    // then ten newer circles, each cancelled before it started: the first page holds only these
    for (let k = 0; k < 10; k++) {
      const x = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [params, members])) as Address;
      await write(wallets[0]!, x, othelloCircleAbi as Abi, "cancelCircle");
    }

    // the chain's own answer, read with the app's readCircle: the oldest circle waits on this wallet
    const { readCircle } = await import(pathToFileURL(resolve(SRC, "lib/robinhood/adapter-core.ts")).href);
    const { rhToList } = await import(pathToFileURL(resolve(SRC, "lib/robinhood/to-list.ts")).href);
    const { circleCard } = await import(pathToFileURL(resolve(SRC, "lib/core/circle-card.ts")).href);
    const onChain = circleCard(rhToList(await readCircle(pub, waiting, USDG), accounts[0]!.address), accounts[0]!.address);
    assert.equal(onChain.group, "needs", "precondition: the oldest circle waits on the wallet on chain");

    const code = await pub.getCode({ address: factory });
    g.__a6rFactory = Object.freeze({ address: factory, codeHash: keccak256(code!) });
    g.__a6rClient = createPublicClient({ chain, transport: http(undefined, { batch: true }) });
    g.__a6rWallet = accounts[0]!.address;
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
    // the factory check, the first page, then its ten circle reads in turn
    for (let k = 0; k < 600 && !(source.found === 10 && source.reading === 0); k++) {
      await sleep(100);
      source = step();
    }
    assert.ok(source.blocked === null && !source.error, `precondition: the factory check and the list read passed (${String(source.error)})`);
    assert.equal(source.found, 10, "precondition: the first page lists the ten newest circles");
    assert.equal(source.reading, 0, "precondition: every listed read has finished");
    assert.equal(source.failed.length, 0, "precondition: no read failed");
    assert.ok(source.more, "precondition: older circles exist (Show more)");
    assert.ok(!source.circles.some((c: { address: string }) => c.address.toLowerCase() === waiting.toLowerCase()),
      "precondition: the waiting circle is not among the circles read");

    html = renderToStaticMarkup(React.createElement(CirclesHome, { source }));
    assert.ok(html.includes("Show more"), "precondition: the page offers the older circles");
  });
  after(() => {
    anvil?.kill();
  });

  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("the pill does not say 'All caught up' while an older circle, not read, waits on the wallet", () => {
    const pill = html.match(/<button[^>]*class="pill"[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/button>/);
    assert.ok(pill, "precondition: the Needs-you pill is drawn");
    const said = `${pill![1]} | ${text(pill![2]!)}`;
    assert.ok(!/All caught up|Nothing waiting on you/.test(said),
      `the pill claims nothing waits on the wallet, but the circle on the unread second page does: "${said}"`);
  });

  it("the phone strip does not say 'All caught up' while an older circle, not read, waits on the wallet", () => {
    const strip = html.match(/<button[^>]*class="needs [^"]*"[^>]*>(.*?)<\/button>/);
    assert.ok(strip, "precondition: the phone's Needs-you strip is drawn");
    const said = text(strip![1]!);
    assert.ok(!/All caught up/.test(said), `the phone strip claims nothing waits on the wallet: "${said}"`);
  });

  it("the board does not say no circles are running while older circles are not read", () => {
    assert.ok(!html.includes("No circles running right now"),
      "'No circles running right now' is drawn while the wallet's older circles (one Forming, waiting on it) are unread");
  });
});
