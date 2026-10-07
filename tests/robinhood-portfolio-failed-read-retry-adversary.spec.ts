/**
 * Adversary, shared circles list merged with the Robinhood portfolio (PR #25 at 432dfb5, merging staging dd01b4d).
 * Spec item 4: "No error text on either page contains the RPC URL or request bodies; a failed read (the factory check
 * and a failed page read included) says it failed and offers a retry, never "not open" or "no circles"".
 *
 * The /robinhood circles list (components/robinhood/RobinhoodHome.tsx) offers "Try again" for both failures. The
 * /robinhood/portfolio page (components/robinhood/RobinhoodPortfolio.tsx) reads the same two things (checkFactory, then
 * listMyCircles, whose page now throws when its own factory check fails) and, when either fails, draws "Live data
 * unavailable" in the "Your circle" card with no way to read again: no button, no link that retries. The only way back
 * is a full page reload, which the page never offers.
 *
 * The chain is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630), the
 * pinned factory code placed at the pinned address (the harness of robinhood-portfolio-first-page-check-adversary.spec.ts).
 * The wallet (account 0) creates one circle with createCircle. The one injected fault per case:
 *   - a failed page read: the first circlesOfCount call (the first page of listMyCircles) rejects, as an RPC timeout would;
 *   - a failed factory check: the first getCode of the factory (checkFactory) rejects.
 * Every other read goes to anvil.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-failed-read-retry-adversary.spec.ts
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

const PORT = 8723;
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

type Fault = "page" | "factory" | null;
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

describe("Robinhood portfolio adversary: a failed circles read offers no retry (anvil, chain 46630)", function () {
  this.timeout(300_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let me: WalletClient;
  let Page: () => unknown;
  // which read fails once, and whether it has failed yet
  let fault: Fault = null;
  let tripped = false;

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

    g.__rhClient = new Proxy(pub, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (typeof v !== "function") return v;
        if (key === "getCode") {
          return async (args: { address: Address }) => {
            if (fault === "factory" && !tripped && getAddress(args.address) === getAddress(TRUSTED_FACTORY!.address)) {
              tripped = true;
              throw new Error("The request took too long to respond.");
            }
            return (v as (a: unknown) => unknown).call(target, args);
          };
        }
        if (key === "readContract") {
          return async (args: { functionName: string }) => {
            if (fault === "page" && !tripped && args.functionName === "circlesOfCount") {
              tripped = true;
              throw new Error("The request took too long to respond.");
            }
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

  /** Runs the page's effects to the circle card's settled state with `f` injected once, then the card's markup. */
  async function failedCard(f: Fault): Promise<string> {
    const { renderToStaticMarkup } = appRequire("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
    fault = f;
    tripped = false;
    g.__rhStore = {};
    g.__rhEffects = true;
    g.__rhIdx = 0;
    const settled = new Promise<{ kind: string }>((done) => {
      g.__rhOnSet = (i, v) => { if (i === 3 && (v as { kind: string }).kind !== "reading") done(v as { kind: string }); };
    });
    Page();
    const state = await settled;
    assert.ok(tripped, "precondition: the injected fault fired");
    assert.equal(state.kind, "failed", "precondition: the page recorded the circles read as failed");
    g.__rhEffects = false;
    g.__rhIdx = 0;
    const html = renderToStaticMarkup(Page());
    const section = html.slice(html.indexOf('aria-label="Your circle"'));
    return section.slice(0, section.indexOf("</section>"));
  }

  const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  /** A control that reads again: a button, or a link, whose words say retry. */
  const retryControl = (h: string) =>
    [...h.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/g)].some((m) => /try again|retry|reload|read again/i.test(strip(m[2]!)));

  it("the contract: the wallet has created one circle", async () => {
    const n = await pub.readContract({
      address: TRUSTED_FACTORY!.address, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [accounts[0]!.address],
    } as never);
    assert.equal(Number(n), 1);
  });

  it("a failed page read says it failed and offers a retry", async () => {
    const card = await failedCard("page");
    assert.match(strip(card), /could not read your circles/i, "precondition: the card says the read failed");
    assert.ok(retryControl(card), `the circles read failed once (circlesOfCount timed out) and the card offers no retry: "${strip(card)}"`);
  });

  it("a failed factory check says it failed and offers a retry", async () => {
    const card = await failedCard("factory");
    assert.match(strip(card), /could not read your circles/i, "precondition: the card says the read failed");
    assert.ok(retryControl(card), `the factory check failed once (getCode timed out) and the card offers no retry: "${strip(card)}"`);
  });
});
