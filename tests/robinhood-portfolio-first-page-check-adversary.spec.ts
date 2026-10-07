/**
 * Adversary, Robinhood portfolio (app/src/components/robinhood/RobinhoodPortfolio.tsx), pass on c2b6549.
 * Spec item 2: "Any text about how many circles the wallet has, or whether one is running, is true." Spec item 4: "a
 * failed read says it failed".
 *
 * c2b6549 treats a later page whose own factory check fails (listCirclesPageWith returns total 0, circles []) as a failed
 * read, so the count is never overwritten. The first page runs the same check (adapter-core.ts checkTrustedFactory, a
 * second getCode of the factory after the page's checkFactory) and is not guarded: when that one check sees no factory
 * code, the page records { kind: "ready", count: 0 } and the card tells a wallet that has a circle "This wallet hasn't
 * started or joined a circle yet." with a "Start a circle" button, while the header says everything read live.
 *
 * The chain is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630), the
 * pinned factory code placed at the pinned address (the harness of robinhood-portfolio-late-sub-adversary.spec.ts).
 * The wallet (account 0) creates one circle with createCircle. The only fault injected: the page's public client
 * answers the SECOND getCode of the factory address with "0x", as a load-balanced RPC replica that is behind or
 * misbehaving would (the same condition c2b6549 guards on pages after the first). Every other read goes to anvil.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-first-page-check-adversary.spec.ts
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

const PORT = 8701;
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

describe("Robinhood portfolio adversary: the first page's factory check fails after checkFactory passed (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let me: WalletClient;
  let Page: () => unknown;
  let factoryCodeReads = 0;

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
      args: [params, accounts.map((a) => a.address)], account: me.account!, chain,
    } as never);
    await pub.waitForTransactionReceipt({ hash });

    // the one injected fault: the second getCode of the factory (the first page's own check) sees no code
    g.__rhClient = new Proxy(pub, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (key === "getCode" && typeof v === "function") {
          return async (args: { address: Address }) => {
            if (getAddress(args.address) === getAddress(TRUSTED_FACTORY!.address) && ++factoryCodeReads === 2) return "0x";
            return (v as (a: unknown) => unknown).call(target, args);
          };
        }
        return v;
      },
    });
    g.__rhWallet = { address: accounts[0]!.address as Address, onRobinhood: true, switchToRobinhood: async () => {} };
    g.React = appRequire("react"); // the page is compiled with the classic JSX transform
    Page = (await import(pathToFileURL(PAGE).href)).default as () => unknown;
  });

  after(() => { anvil?.kill(); });

  it("the contract: the wallet has created one circle", async () => {
    const n = await pub.readContract({
      address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [accounts[0]!.address],
    } as never);
    assert.equal(Number(n), 1);
  });

  it("the card never says a wallet with a circle has none when a read of its circles failed", async () => {
    const { renderToStaticMarkup } = appRequire("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
    g.__rhStore = {};
    g.__rhEffects = true;
    g.__rhIdx = 0;
    const settled = new Promise<{ kind: string }>((done) => {
      g.__rhOnSet = (i, v) => { if (i === 3 && (v as { kind: string }).kind !== "reading") done(v as { kind: string }); };
    });
    Page();
    await settled;
    assert.equal(factoryCodeReads, 2, "precondition: checkFactory passed and the first page ran its own factory check");
    g.__rhEffects = false;
    g.__rhIdx = 0;
    const html = renderToStaticMarkup(Page());
    const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
    const section = html.slice(html.indexOf('aria-label="Your circle"'));
    const cardText = strip(section.slice(0, section.indexOf("</section>")).replace(/^[^>]*>/, ""));
    assert.doesNotMatch(
      cardText,
      /hasn't started or joined a circle/i,
      `the wallet has created 1 circle and the first page's factory check failed, yet the card reads: "${cardText}"`,
    );
  });
});
