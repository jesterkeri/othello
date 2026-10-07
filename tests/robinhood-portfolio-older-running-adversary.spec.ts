/**
 * Adversary, Robinhood portfolio (app/src/components/robinhood/RobinhoodPortfolio.tsx), pass on b1b1c30.
 * Spec item 2: "Any text about how many circles the wallet is in, or that none is running, is true." Spec item 1: the
 * card is for the wallet's "most relevant running circle".
 *
 * readRunningCircles reads at most three pages (30 circles, newest first) of the factory's per-wallet index. The page's
 * own reason it is safe ("a running circle is among the newest: a member is in at most three at a time") is not a rule
 * of the contracts: evm/src/OthelloFactory.sol lists every circle the wallet created or joined (Forming, Cancelled and
 * Completed ones included) and nothing caps how many come after a running one. So a wallet whose one running circle
 * is followed by 30 newer circles it created (still Forming: waiting for members) is told "No running circle", while
 * that circle is Active and its seat has this round's payment due.
 *
 * The chain is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630). As in
 * robinhood-portfolio-unbounded-reads-adversary.spec.ts, MockUSDG's runtime code is placed at the real USDG address
 * and the factory, deployed against it, has exactly the runtime code hash pinned in app/src/lib/robinhood/config.ts,
 * so it is placed at the pinned factory address and the page's own adapter, unmodified, trusts it.
 *   circle A: n=3, c=10, g=5, haircut 20%, coverage 130%, minStockCover 12, roundSecs 3600, grace 600; accounts 0, 1, 2
 *             each lock 20; account 0 activates. Round 1 is running, account 0 (seat 1) has not paid.
 *   then account 0 creates 30 more circles (Forming).
 *
 * The page runs as written; only what a test without a browser needs is swapped: React's useState keeps each value in
 * a store and useEffect runs on the first render only, Shell, next/link and useWalletUi are stubs, and
 * @/lib/robinhood/wallet gives the connected address and a public client for the local chain. After the reads settle
 * the page is rendered again from the stored state with react-dom/server, and its text is checked.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-older-running-adversary.spec.ts
 * Hook-swapping spec: run it in its own process.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPublicClient, createWalletClient, defineChain, erc20Abi, getAddress, http, keccak256, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { USDG } from "../app/src/lib/robinhood/chain.ts";
import { TRUSTED_FACTORY } from "../app/src/lib/robinhood/config.ts";
import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "components/robinhood/RobinhoodPortfolio.tsx");
const appRequire = createRequire(resolve(SRC, "components/robinhood/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

const PORT = 8641;
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

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex; runtime: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, runtime: j.deployedBytecode.object };
}

describe("Robinhood portfolio adversary: a running circle older than the 30 newest (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let running: Address;
  let Page: () => unknown;

  const params = { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n, roundSecs: 3600n, graceSecs: 600n };

  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    const hash = await w.writeContract({ ...(request as object), chain } as never);
    await pub.waitForTransactionReceipt({ hash });
    return result as unknown;
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(RPC) }));
    const me = wallets[0]!;
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    await pub.request({ method: "anvil_setCode", params: [USDG, mock.runtime] } as never);
    const fac = artifact("OthelloFactory.sol", "OthelloFactory");
    const fh = await me.deployContract({ abi: fac.abi, bytecode: fac.bytecode, args: [USDG], account: me.account!, chain });
    const built = (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress!;
    const code = (await pub.getCode({ address: built }))!;
    assert.equal(keccak256(code), TRUSTED_FACTORY!.codeHash.toLowerCase(), "precondition: the local factory has the pinned code hash");
    await pub.request({ method: "anvil_setCode", params: [TRUSTED_FACTORY!.address, code] } as never);
    const factory = TRUSTED_FACTORY!.address;
    const members = accounts.map((a) => a.address);

    // circle A: everyone joins, account 0 activates; round 1 runs and account 0 has not paid
    for (const a of accounts) await write(me, USDG, mock.abi, "mint", [a.address, 1_000n * U]);
    running = (await write(me, factory, othelloFactoryAbi as Abi, "createCircle", [params, members])) as Address;
    for (const w of wallets) {
      await write(w, USDG, erc20Abi as Abi, "approve", [running, 1_000n * U]);
      await write(w, running, othelloCircleAbi as Abi, "joinAndLock", [20n * U]);
    }
    await write(me, running, othelloCircleAbi as Abi, "activate");
    // then 30 newer circles the wallet created, waiting for members
    for (let i = 0; i < 30; i++) await write(me, factory, othelloFactoryAbi as Abi, "createCircle", [params, members]);

    g.__rhClient = pub;
    g.__rhWallet = { address: accounts[0]!.address as Address, onRobinhood: true, switchToRobinhood: async () => {} };
    g.React = appRequire("react"); // the page is compiled with the classic JSX transform
    Page = (await import(pathToFileURL(PAGE).href)).default as () => unknown;
  });

  after(() => { anvil?.kill(); });

  it("the contract: circle A is running, account 0 holds seat 1 and has this round's payment due", async () => {
    const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
      pub.readContract({ address: running, abi: othelloCircleAbi, functionName, args } as never) as Promise<T>;
    assert.equal(Number(await r<number>("status")), 1, "Active");
    assert.equal(getAddress(await r<Address>("members", [0n])), getAddress(accounts[0]!.address));
    assert.equal(Number(await r<number>("paidBitmap")) & 1, 0, "seat 1 has not paid round 1");
    const count = await pub.readContract({ address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [accounts[0]!.address] } as never);
    assert.equal(count, 31n, "the wallet's index: circle A, then 30 newer circles");
  });

  it("the page does not say no circle is running while circle A is running", async () => {
    const { renderToStaticMarkup } = appRequire("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
    // first render: the effect starts the reads; wait for the circle card's read (useState index 3) to settle
    g.__rhStore = {};
    g.__rhEffects = true;
    g.__rhIdx = 0;
    const settled = new Promise<{ kind: string }>((done) => {
      g.__rhOnSet = (i, v) => { if (i === 3 && (v as { kind: string }).kind !== "reading") done(v as { kind: string }); };
    });
    Page();
    const card = await settled;
    assert.equal(card.kind, "ready", "precondition: the page read the wallet's circles");
    // second render: the stored state, no effect
    g.__rhEffects = false;
    g.__rhIdx = 0;
    const html = renderToStaticMarkup(Page());
    const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const text = strip(html);
    const shown = html.includes(`/circle/rh:${getAddress(running)}`);
    const saysNone = /No running circle|none is running/i.test(text);
    const section = html.slice(html.indexOf('aria-label="Your circle"'));
    const cardText = strip(section.slice(0, section.indexOf("</section>")).replace(/^[^>]*>/, ""));
    assert.ok(
      shown || !saysNone,
      `circle A (${running}) is Active with this wallet's payment due, yet the "Your circle" card reads: "${cardText}"`,
    );
  });
});
