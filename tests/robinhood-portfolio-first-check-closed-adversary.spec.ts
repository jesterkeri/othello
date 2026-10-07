/**
 * Adversary, Robinhood portfolio (app/src/components/robinhood/RobinhoodPortfolio.tsx), pass on 12fdfe9.
 * Spec item 2: "Any text about how many circles the wallet has, or whether one is running, is true." Spec item 4: "a
 * failed read says it failed (never looks like it is still loading or like an empty result)".
 *
 * 12fdfe9 makes a factory that fails its code check a failed read in listCirclesPageWith ("A factory whose code no
 * longer matches its pin is a failed read, never an empty list", adapter-core.ts). The portfolio runs the same code
 * check one call earlier (checkFactory, the first getCode of the factory) and maps its failure, reason "factory-code",
 * to { kind: "closed" }: the card says "Circles aren't open yet" and the header still says the page read live, for a
 * wallet that is in a running circle on that very factory.
 *
 * The chain is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630), the
 * pinned factory code placed at the pinned address (the harness of robinhood-portfolio-late-sub-adversary.spec.ts).
 * Accounts 0, 1 and 2 create, join and activate one circle. The only fault injected: the page's public client answers
 * the FIRST getCode of the factory address with "0x" (a load-balanced RPC replica that is behind or misbehaving, the
 * fault of robinhood-portfolio-first-page-check-adversary.spec.ts moved one read earlier). Every other read goes to
 * anvil. A control render without the fault shows the circle.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-first-check-closed-adversary.spec.ts
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

const PORT = 8713;
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

describe("Robinhood portfolio adversary: the first factory check sees no code for a wallet in a running circle (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let circle: Address;
  let Page: () => unknown;
  let fault = false;
  let factoryCodeReads = 0;

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
    const C = othelloCircleAbi as Abi;
    for (const a of accounts) await write(me, USDG, mock.abi, "mint", [a.address, 1_000n * U]);
    circle = (await write(me, TRUSTED_FACTORY!.address, othelloFactoryAbi as Abi, "createCircle", [params, accounts.map((a) => a.address)])) as Address;
    for (const w of wallets) {
      await write(w, USDG, erc20Abi as Abi, "approve", [circle, 1_000n * U]);
      await write(w, circle, C, "joinAndLock", [20n * U]);
    }
    await write(me, circle, C, "activate");

    // the one injected fault, when on: the first getCode of the factory (the page's checkFactory) sees no code
    g.__rhClient = new Proxy(pub, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (key === "getCode" && typeof v === "function") {
          return async (args: { address: Address }) => {
            if (getAddress(args.address) === getAddress(TRUSTED_FACTORY!.address) && ++factoryCodeReads === 1 && fault) return "0x";
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

  async function render(): Promise<{ kind: string; header: string; card: string }> {
    const { renderToStaticMarkup } = appRequire("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
    factoryCodeReads = 0;
    g.__rhStore = {};
    g.__rhEffects = true;
    g.__rhIdx = 0;
    const settled = new Promise<{ kind: string }>((done) => {
      g.__rhOnSet = (i, v) => { if (i === 3 && (v as { kind: string }).kind !== "reading") done(v as { kind: string }); };
    });
    Page();
    const read = await settled;
    g.__rhEffects = false;
    g.__rhIdx = 0;
    const html = renderToStaticMarkup(Page());
    const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
    const section = html.slice(html.indexOf('aria-label="Your circle"'));
    const card = strip(section.slice(0, section.indexOf("</section>")).replace(/^[^>]*>/, ""));
    const header = strip(html.slice(html.indexOf("<header"), html.indexOf("</header>")));
    return { kind: read.kind, header, card };
  }

  it("the contract: the wallet is in one running circle on the pinned factory", async () => {
    const n = await pub.readContract({
      address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [accounts[0]!.address],
    } as never);
    assert.equal(Number(n), 1);
    const status = await pub.readContract({ address: circle, abi: othelloCircleAbi, functionName: "status" } as never);
    assert.equal(Number(status), 1, "Active");
  });

  it("control: without the fault the card shows the running circle", async () => {
    fault = false;
    const r = await render();
    assert.equal(r.kind, "ready");
    assert.match(r.card, /Round 1 of 3/, `control card reads: "${r.card}"`);
  });

  it("the card never says circles are not open for a wallet in a running circle when the factory check's read failed", async () => {
    fault = true;
    const r = await render();
    assert.equal(factoryCodeReads, 1, "precondition: only the faulted checkFactory read the factory's code");
    assert.doesNotMatch(
      r.card,
      /aren't open yet/i,
      `the wallet is in a running circle and one read of the factory's code returned "0x", yet the card reads: "${r.card}" and the header: "${r.header}"`,
    );
  });
});
