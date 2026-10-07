/**
 * Adversary, Robinhood portfolio (app/src/components/robinhood/RobinhoodPortfolio.tsx), pass on d82d67e.
 * Spec item 4: "Reads are bounded". The adapter states what bounded means for the circle list
 * (app/src/lib/robinhood/adapter-core.ts, listCirclesPageWith): "The reads are bounded by pageSize, never by how many
 * circles the chain has." The portfolio's readRunningCircles walks listMyCircles page after page until `before` is
 * null, so the page reads every circle the wallet has ever created or joined, each with 5 + n calls, before the card
 * draws. A bounded page reads the same amount for a wallet with 120 circles as for one with 240.
 *
 * The chain is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630). The
 * factory is deployed with the real USDG address as its token (MockUSDG's runtime code placed there, as the factory's
 * constructor checks decimals), which gives it exactly the runtime code hash pinned in app/src/lib/robinhood/config.ts;
 * that code is then placed at the pinned factory address, so the page's own adapter, unmodified, trusts it. The wallet
 * creates its circles with createCircle (each one Forming: a wallet's abandoned or waiting circles).
 *
 * The page runs as written; only what a test without a browser needs is swapped: React's useState records each setter
 * call and useEffect runs its effect once, Shell and useWalletUi are stubs, and @/lib/robinhood/wallet gives the
 * connected address and a public client for the local chain that counts each read the page makes.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-unbounded-reads-adversary.spec.ts
 * Hook-swapping spec: run it in its own process.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPublicClient, createWalletClient, defineChain, http, keccak256, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { USDG } from "../app/src/lib/robinhood/chain.ts";
import { TRUSTED_FACTORY } from "../app/src/lib/robinhood/config.ts";
import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "components/robinhood/RobinhoodPortfolio.tsx");
const appRequire = createRequire(resolve(SRC, "components/robinhood/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

const PORT = 8633;
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
  __rhSet?: (i: number, v: unknown) => void;
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
      const stub =
        `import real from ${JSON.stringify(REACT_URL)};` +
        "export default real;" +
        "export function useEffect(fn) { fn(); }" +
        "export function useState(init) { const i = globalThis.__rhIdx++; return [init, (v) => globalThis.__rhSet(i, v)]; }";
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

describe("Robinhood portfolio adversary: the circle reads grow with the wallet's circle count (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let me: WalletClient;
  let reads = 0;
  let Page: () => unknown;

  const params = { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n, roundSecs: 60n, graceSecs: 30n };

  async function create(count: number) {
    for (let i = 0; i < count; i++) {
      const hash = await me.writeContract({
        address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi as Abi, functionName: "createCircle",
        args: [params, accounts.map((a) => a.address)], account: me.account!, chain,
      } as never);
      await pub.waitForTransactionReceipt({ hash });
    }
  }

  /** Runs the page's effect for the connected wallet and returns how many reads it made before the card settled. */
  async function readsForCard(): Promise<{ reads: number; card: { kind: string; count?: number } }> {
    let settled: (v: { kind: string; count?: number }) => void;
    const done = new Promise<{ kind: string; count?: number }>((r) => { settled = r; });
    g.__rhIdx = 0;
    // the page's useState order: usdgRead, ethRead, stocksState, circlesRead, readFor
    g.__rhSet = (i, v) => {
      if (i === 3 && (v as { kind: string }).kind !== "reading") settled(v as { kind: string; count?: number });
    };
    reads = 0;
    Page();
    const card = await done;
    return { reads, card };
  }

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

    const counted = new Set(["readContract", "getCode", "getBlock", "getBalance", "multicall"]);
    g.__rhClient = new Proxy(pub, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (typeof key === "string" && counted.has(key) && typeof v === "function") {
          return (...args: unknown[]) => { reads += 1; return (v as (...a: unknown[]) => unknown).apply(target, args); };
        }
        return v;
      },
    });
    g.__rhWallet = { address: accounts[0]!.address as Address, onRobinhood: true, switchToRobinhood: async () => {} };
    g.React = appRequire("react"); // the page is compiled with the classic JSX transform
    Page = (await import(pathToFileURL(PAGE).href)).default as () => unknown;
  });

  after(() => { anvil?.kill(); });

  it("reads the same amount for a wallet with 240 circles as for one with 120", async () => {
    await create(120);
    const a = await readsForCard();
    assert.equal(a.card.kind, "ready", "precondition: the page read the wallet's circles (120, none running)");
    await create(120);
    const b = await readsForCard();
    assert.equal(b.card.kind, "ready", "precondition: the page read the wallet's circles (240, none running)");
    assert.equal(
      b.reads,
      a.reads,
      `reads are not bounded: the page made ${a.reads} reads for a wallet with 120 circles and ${b.reads} for one with 240, before drawing one card`,
    );
  });
});
