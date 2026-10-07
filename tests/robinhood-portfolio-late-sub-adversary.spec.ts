/**
 * Adversary, Robinhood portfolio (app/src/components/robinhood/RobinhoodPortfolio.tsx), pass on a486495.
 * Spec item 1: every figure and note on the "Your circle" card matches the contract for that seat, including "this
 * round's payment state (paid / due / late by chain time / settled in default)". Due and late are different states;
 * tests/a5-ring-late-adversary.spec.ts holds the circle page to the same rule ("late, not merely due").
 *
 * The page appends " · your payment is due" to the card's seat line whenever card.mustAct is true. mustAct is true for
 * every joined, unpaid, not-defaulted seat, late ones included, so a seat whose missed payment the contract has
 * recorded (markDelinquent: delinquentBitmap set, only possible once block.timestamp > deadline + graceSecs) gets a
 * card that says "your payment is due" next to a "Round 1: late" chip.
 *
 * The chain is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630).
 * MockUSDG's runtime code is placed at the real USDG address and the factory, deployed against it, has exactly the
 * runtime code hash pinned in app/src/lib/robinhood/config.ts, so it is placed at the pinned factory address and the
 * page's own adapter, unmodified, trusts it (the harness of robinhood-portfolio-older-running-adversary.spec.ts).
 *   n=3, c=10, g=5, haircut 20%, coverage 130%, minStockCover 12, roundSecs 60, grace 30; accounts 0, 1, 2 each lock
 *   20; account 0 activates. Round 1: accounts 1 and 2 pay, account 0 (seat 1) does not. The chain moves 120 s
 *   ahead, past deadline + grace, and account 1 calls markDelinquent(0, 0).
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-late-sub-adversary.spec.ts
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

const PORT = 8689;
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

describe("Robinhood portfolio adversary: the card of a seat whose payment is late (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let circle: Address;
  let Page: () => unknown;

  const params = { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n, roundSecs: 60n, graceSecs: 30n };

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
    const C = othelloCircleAbi as Abi;

    for (const a of accounts) await write(me, USDG, mock.abi, "mint", [a.address, 1_000n * U]);
    circle = (await write(me, factory, othelloFactoryAbi as Abi, "createCircle", [params, accounts.map((a) => a.address)])) as Address;
    for (const w of wallets) {
      await write(w, USDG, erc20Abi as Abi, "approve", [circle, 1_000n * U]);
      await write(w, circle, C, "joinAndLock", [20n * U]);
    }
    await write(me, circle, C, "activate");
    await write(wallets[1]!, circle, C, "contribute");
    await write(wallets[2]!, circle, C, "contribute");
    await pub.request({ method: "evm_increaseTime", params: [120] } as never);
    await pub.request({ method: "evm_mine", params: [] } as never);
    await write(wallets[1]!, circle, C, "markDelinquent", [0, 0]);

    g.__rhClient = pub;
    g.__rhWallet = { address: accounts[0]!.address as Address, onRobinhood: true, switchToRobinhood: async () => {} };
    g.React = appRequire("react"); // the page is compiled with the classic JSX transform
    Page = (await import(pathToFileURL(PAGE).href)).default as () => unknown;
  });

  after(() => { anvil?.kill(); });

  it("the contract: seat 1 is unpaid, past deadline + grace, and its missed payment is recorded", async () => {
    const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
      pub.readContract({ address: circle, abi: othelloCircleAbi, functionName, args } as never) as Promise<T>;
    assert.equal(Number(await r<number>("status")), 1, "Active");
    assert.equal(getAddress(await r<Address>("members", [0n])), getAddress(accounts[0]!.address));
    assert.equal(Number(await r<number>("paidBitmap")) & 1, 0, "seat 1 has not paid round 1");
    assert.equal(Number(await r<number>("delinquentBitmap")) & 1, 1, "markDelinquent recorded seat 1's payment as missed");
    const block = await pub.getBlock();
    assert.ok(block.timestamp > (await r<bigint>("deadline")) + 30n, "the chain is past deadline + grace");
  });

  it("the card does not call a late payment merely due", async () => {
    const { renderToStaticMarkup } = appRequire("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
    // first render: the effect starts the reads; wait for the circle card's read (useState index 3) to settle
    g.__rhStore = {};
    g.__rhEffects = true;
    g.__rhIdx = 0;
    const settled = new Promise<{ kind: string }>((done) => {
      g.__rhOnSet = (i, v) => { if (i === 3 && (v as { kind: string }).kind !== "reading") done(v as { kind: string }); };
    });
    Page();
    const read = await settled;
    assert.equal(read.kind, "ready", "precondition: the page read the wallet's circles");
    // second render: the stored state, no effect
    g.__rhEffects = false;
    g.__rhIdx = 0;
    const html = renderToStaticMarkup(Page());
    const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const section = html.slice(html.indexOf('aria-label="Your circle"'));
    const cardText = strip(section.slice(0, section.indexOf("</section>")).replace(/^[^>]*>/, ""));
    assert.ok(html.includes(`/circle/rh:${getAddress(circle)}`), `precondition: the card shows the circle; it reads "${cardText}"`);
    assert.match(cardText, /Round 1 late/, "precondition: the card's round chip says late");
    assert.doesNotMatch(
      cardText,
      /payment is due/i,
      `seat 1's payment is late (past deadline + grace, recorded by markDelinquent), yet the card reads: "${cardText}"`,
    );
  });
});
