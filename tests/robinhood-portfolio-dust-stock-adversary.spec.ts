/**
 * Adversary, Robinhood portfolio (app/src/components/robinhood/RobinhoodPortfolio.tsx), pass on a1496e6.
 * Spec item 1: the page "shows the connected wallet's real test-token balances".
 *
 * fmtStock cuts a Stock Token balance to four decimals, so a balance below 0.0001 is drawn as "0", while the page's new
 * count ("N of 5 held") counts every balance above zero. A wallet holding 0.00005 TSLA (5e13 base units, the token has
 * 18 decimals) is told "1 of 5 held" and, in the legend and in the TSLA asset row, "0 TSLA": the page says it holds
 * a Stock Token and shows every one of them at zero.
 *
 * The chain is a local anvil with Robinhood testnet's chain id (46630). MockUSDG's runtime code (evm/test, the repo's
 * own plain ERC-20) is placed at USDG and at the five Stock Token addresses of app/src/lib/robinhood/testnet-stocks.ts,
 * so balanceOf answers there; the wallet is minted 1 USDG and 5e13 base units of TSLA, nothing of the other four. No
 * factory is placed, so the circle card says circles are not open; that card is not under test here.
 *
 * The page runs as written; as in robinhood-portfolio-older-running-adversary.spec.ts only what a test without a
 * browser needs is swapped (React's useState kept in a store, useEffect on the first render only, Shell, next/link,
 * useWalletUi and @/lib/robinhood/wallet stubbed). After the reads settle the page is rendered again with
 * react-dom/server and its text is checked.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-dust-stock-adversary.spec.ts
 * Hook-swapping spec: run it in its own process.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { USDG } from "../app/src/lib/robinhood/chain.ts";
import { TESTNET_STOCK_TOKENS } from "../app/src/lib/robinhood/testnet-stocks.ts";
import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "components/robinhood/RobinhoodPortfolio.tsx");
const appRequire = createRequire(resolve(SRC, "components/robinhood/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

const PORT = 8653;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
// anvil's public development mnemonic; this account exists only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
const DUST = 50_000_000_000_000n; // 0.00005 TSLA at 18 decimals

type G = {
  __rhClient?: unknown;
  __rhWallet?: unknown;
  __rhIdx?: number;
  __rhStore?: Record<number, unknown>;
  __rhEffects?: boolean;
  __rhOnSet?: (i: number, v: unknown) => void;
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
        "export function useEffect(fn) { if (globalThis.__rhEffects) fn(); }" +
        "export function useState(init) {" +
        "  const i = globalThis.__rhIdx++; const st = globalThis.__rhStore;" +
        "  const cur = () => (i in st ? st[i] : init);" +
        "  return [cur(), (v) => { st[i] = typeof v === 'function' ? v(cur()) : v; globalThis.__rhOnSet?.(i, st[i]); }];" +
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

function artifact(file: string, name: string): { abi: Abi; runtime: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, runtime: j.deployedBytecode.object };
}

describe("Robinhood portfolio adversary: a Stock Token balance below 0.0001 (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const me = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  let wallet: WalletClient;
  let Page: () => unknown;

  async function write(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request } = await pub.simulateContract({ address, abi, functionName, args, account: me } as never);
    const hash = await wallet.writeContract({ ...(request as object), chain } as never);
    await pub.waitForTransactionReceipt({ hash });
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    wallet = createWalletClient({ account: me, chain, transport: http(RPC) });
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    for (const address of [USDG, ...TESTNET_STOCK_TOKENS.map((t) => t.address)]) {
      await pub.request({ method: "anvil_setCode", params: [address, mock.runtime] } as never);
    }
    await write(USDG, mock.abi, "mint", [me.address, 1_000_000n]);
    await write(TESTNET_STOCK_TOKENS[0].address, mock.abi, "mint", [me.address, DUST]);

    g.__rhClient = pub;
    g.__rhWallet = { address: me.address as Address, onRobinhood: true, switchToRobinhood: async () => {} };
    g.React = appRequire("react"); // the page is compiled with the classic JSX transform
    Page = (await import(pathToFileURL(PAGE).href)).default as () => unknown;
  });

  after(() => { anvil?.kill(); });

  it("the chain: the wallet holds 0.00005 TSLA and none of the other four", async () => {
    const abi = artifact("MockUSDG.sol", "MockUSDG").abi;
    for (const [i, t] of TESTNET_STOCK_TOKENS.entries()) {
      const b = await pub.readContract({ address: t.address, abi, functionName: "balanceOf", args: [me.address] } as never);
      assert.equal(b, i === 0 ? DUST : 0n, t.symbol);
    }
  });

  it("the page does not draw a held Stock Token as 0", async () => {
    const { renderToStaticMarkup } = appRequire("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
    // first render: the effect starts the reads; wait until all five Stock Token reads (useState index 2) have settled
    g.__rhStore = {};
    g.__rhEffects = true;
    g.__rhIdx = 0;
    const settled = new Promise<void>((done) => {
      g.__rhOnSet = (i, v) => { if (i === 2 && Object.keys(v as object).length === TESTNET_STOCK_TOKENS.length) done(); };
    });
    Page();
    await settled;
    await sleep(200); // the other reads (USDG, ETH, the factory check) settle too
    g.__rhEffects = false;
    g.__rhIdx = 0;
    const text = renderToStaticMarkup(Page()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const count = text.match(/\d of 5 held/)?.[0] ?? "no count";
    assert.doesNotMatch(
      text,
      /(^|[^\d.,])0 TSLA/,
      `the wallet holds 0.00005 TSLA (the page's own count: "${count}"), yet it draws "0 TSLA": ${text.match(/.{0,60}0 TSLA.{0,40}/)?.[0]}`,
    );
  });
});
