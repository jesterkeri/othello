/**
 * Adversary on 55f8770 (PR #25, shared circles list). Spec item 2: "after a wallet switch or Try again, nothing for the
 * old card is drawn or acted on, and no read or listing call for it starts after the switch".
 *
 * The portfolio's circle card (components/robinhood/RobinhoodPortfolio.tsx, readRunningCircles) now asks stale() only
 * between pages. One page of listMyCircles (lib/robinhood/adapter-core.ts listCirclesPageWith) is several rounds of
 * calls in a row: the factory check, circlesOfCount, circlesOfPage, then five reads per circle and one per seat
 * (summarize). A switch that lands while the page's first call is on the wire lets every later round of that page start
 * for the wallet the card has left: up to 2 + 10 * (5 + n) listing calls on the public RPC, outside the read queue,
 * ahead of the new wallet's own reads.
 *
 * The chain is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630), the
 * pinned factory code placed at the pinned address (the harness of robinhood-portfolio-failed-read-retry-adversary
 * .spec.ts). Wallet A (account 0) creates one circle with createCircle; wallet B (account 3) has none. The one injected
 * fault: wallet A's circlesOfCount answer is held until the page has switched to wallet B, as a slow RPC would hold it.
 * The switch is what React does when wallet.address changes: each effect's cleanup runs, then the page renders for B.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-mid-page-switch-adversary.spec.ts
 * Hook-swapping spec: run it in its own process.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { USDG } from "../app/src/lib/robinhood/chain.ts";
import { TRUSTED_FACTORY } from "../app/src/lib/robinhood/config.ts";
import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "components/robinhood/RobinhoodPortfolio.tsx");
const appRequire = createRequire(resolve(SRC, "components/robinhood/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

const PORT = 8743;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
const U = 1_000_000n;

type G = {
  __rhClient?: unknown;
  __rhWallet?: unknown;
  __rhIdx?: number;
  __rhStore?: Record<number, unknown>;
  __rhEffects?: boolean;
  __rhCleanups?: (() => void)[];
  React?: unknown;
};
const g = globalThis as G;

registerHooks({
  resolve(specifier, context, next) {
    const fromPage = context.parentURL?.includes("/components/robinhood/RobinhoodPortfolio.tsx") ?? false;
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
    if (fromPage && specifier === "react") {
      // effects run inline and keep their cleanups, so the test can do what React does on a wallet switch
      const stub =
        `import real from ${JSON.stringify(REACT_URL)};` +
        "export default real;" +
        "export function useEffect(fn) { if (globalThis.__rhEffects) { const c = fn(); if (typeof c === 'function') globalThis.__rhCleanups.push(c); } }" +
        "export function useState(init) {" +
        "  const i = globalThis.__rhIdx++; const st = globalThis.__rhStore;" +
        "  const cur = () => (i in st ? st[i] : init);" +
        "  return [cur(), (v) => { st[i] = typeof v === 'function' ? v(cur()) : v; }];" +
        "}";
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    if (specifier === "next/link") {
      const stub =
        `import real from ${JSON.stringify(REACT_URL)};` +
        "export default function Link({ href, className, children }) { return real.createElement('a', { href, className }, children); }";
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    if (fromPage && specifier === "@/components/othello/Shell") {
      return { url: "data:text/javascript,export default function Shell(p) { return p.children; }", shortCircuit: true };
    }
    if (fromPage && specifier === "@/lib/wallet") {
      return { url: "data:text/javascript,export function useWalletUi() { return { openConnect() {} }; }", shortCircuit: true };
    }
    if (fromPage && specifier === "@/lib/robinhood/wallet") {
      const stub =
        "export const robinhoodPublicClient = globalThis.__rhClient;" +
        "export function useEvmWallet() { return globalThis.__rhWallet; }";
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
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

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex; runtime: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, runtime: j.deployedBytecode.object };
}

describe("Robinhood portfolio adversary on 55f8770: a wallet switch mid-page (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2, 3].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const A = getAddress(accounts[0]!.address);
  const B = getAddress(accounts[3]!.address);
  let me: WalletClient;
  let circleA: Address;
  let Page: () => unknown;

  // every read the page sends, in order, with what it is for
  const calls: { seq: number; fn: string; to: Address; args: readonly unknown[] }[] = [];
  let seq = 0;
  // wallet A's circlesOfCount is held until `release` is called; `held` resolves once it is on the wire
  let release: () => void = () => {};
  let markHeld: () => void = () => {};
  const held = new Promise<void>((r) => { markHeld = r; });
  const gate = new Promise<void>((r) => { release = r; });

  const params = { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n, roundSecs: 60n, graceSecs: 30n };

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    me = createWalletClient({ account: accounts[0]!, chain, transport: http(RPC) });
    await pub.request({ method: "anvil_setCode", params: [USDG, artifact("MockUSDG.sol", "MockUSDG").runtime] } as never);
    const fac = artifact("OthelloFactory.sol", "OthelloFactory");
    const fh = await me.deployContract({ abi: fac.abi, bytecode: fac.bytecode, args: [USDG], account: me.account!, chain });
    const built = (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress!;
    const code = (await pub.getCode({ address: built }))!;
    assert.equal(keccak256(code), TRUSTED_FACTORY!.codeHash.toLowerCase(), "precondition: the local factory has the pinned code hash");
    await pub.request({ method: "anvil_setCode", params: [TRUSTED_FACTORY!.address, code] } as never);
    const hash = await me.writeContract({
      address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi as Abi, functionName: "createCircle",
      args: [params, accounts.slice(0, 3).map((a) => a.address)], account: me.account!, chain,
    } as never);
    await pub.waitForTransactionReceipt({ hash });
    const page = (await pub.readContract({
      address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi, functionName: "circlesOfPage", args: [A, 0n, 1n],
    } as never)) as readonly Address[];
    circleA = getAddress(page[0]!);

    g.__rhClient = new Proxy(pub, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (typeof v !== "function") return v;
        if (key === "getCode") {
          return async (args: { address: Address }) => {
            calls.push({ seq: ++seq, fn: "getCode", to: getAddress(args.address), args: [] });
            return (v as (a: unknown) => unknown).call(target, args);
          };
        }
        if (key === "readContract") {
          return async (args: { functionName: string; address: Address; args?: readonly unknown[] }) => {
            calls.push({ seq: ++seq, fn: args.functionName, to: getAddress(args.address), args: args.args ?? [] });
            if (args.functionName === "circlesOfCount" && getAddress(String(args.args?.[0])) === A) {
              markHeld();
              await gate;
            }
            return (v as (a: unknown) => unknown).call(target, args);
          };
        }
        return v;
      },
    });
    g.React = appRequire("react"); // the page is compiled with the classic JSX transform
    Page = (await import(pathToFileURL(PAGE).href)).default as () => unknown;
  });

  after(() => { release(); anvil?.kill(); });

  it("the contract: wallet A has created one circle, wallet B none", async () => {
    const count = (w: Address) => pub.readContract({
      address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [w],
    } as never);
    assert.equal(Number(await count(A)), 1);
    assert.equal(Number(await count(B)), 0);
  });

  it("starts no listing call for wallet A once the page has switched to wallet B", async () => {
    g.__rhStore = {};
    g.__rhCleanups = [];
    g.__rhEffects = true;
    g.__rhIdx = 0;
    g.__rhWallet = { address: A, onRobinhood: true, switchToRobinhood: async () => {} };
    Page();
    await held; // wallet A's first page has its count read on the wire

    // the switch: React runs each effect's cleanup, then renders for the new wallet
    for (const c of g.__rhCleanups!.splice(0)) c();
    const switchedAt = seq;
    g.__rhWallet = { address: B, onRobinhood: true, switchToRobinhood: async () => {} };
    g.__rhIdx = 0;
    Page();

    release(); // the slow answer for wallet A arrives
    await sleep(3_000); // anvil answers in milliseconds; this lets every round of A's page run

    const forA = (c: (typeof calls)[number]) =>
      (c.fn === "circlesOfPage" && getAddress(String(c.args[0])) === A) || c.to === circleA;
    const late = calls.filter((c) => c.seq > switchedAt && forA(c));
    assert.ok(calls.some((c) => c.seq <= switchedAt && c.fn === "circlesOfCount"), "precondition: A's page was listing when the switch came");
    assert.deepEqual(
      late.map((c) => c.fn), [],
      `after the switch to wallet B, ${late.length} listing call(s) for wallet A's page started: ${late.map((c) => c.fn).join(", ")}`,
    );
  });
});
