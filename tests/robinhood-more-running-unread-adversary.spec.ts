/**
 * Adversary on 774ca7d (PR #25). Spec 3: "Nothing on either page states something about the wallet's circles that a
 * pending, failed or capped read could make untrue, on Robinhood or Solana; when every circle is read, every count is
 * exact again."
 *
 * 774ca7d makes the finished pile's counts "at least" while circles are unread, but the title row's "N more running"
 * button (app/src/components/circles/CirclesBoard.tsx) still prints an exact count. With four running circles read and
 * a fifth (running on chain) unread, it reads "1 more running" while two more are running.
 *
 * Attack: the wallet creates five circles on the real OthelloFactory (each Forming, its own seat not joined: running and
 * waiting on it). The RPC answers the factory check, the list read and four circle reads, and rate-limits (HTTP 429)
 * every batch that reads the fifth in full. Harness as tests/robinhood-needs-count-unread-adversary.spec.ts (copied).
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-more-running-unread-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
import { USDG } from "../app/src/lib/robinhood/chain.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));
const PORT = 8863;
const PROXY_PORT = 8864;
const ANVIL = `http://127.0.0.1:${PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
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
    // the wallet module: the connected address, and the public client (the app's, but on the local proxy)
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

describe("Adversary on 774ca7d: 'N more running' counts only the circles it read", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let proxy: Server;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  // the circles whose reads the RPC refuses (lower case), filled once they exist
  const refused = new Set<string>();
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
    // the RPC as the page reaches it: everything passes except a batch that reads one of the refused circles in full
    proxy = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        // a full circle read (readCircle) pins its calls to a block hash; the list's summaries read at latest and pass
        const calls = [JSON.parse(body)].flat() as { method: string; params?: [{ to?: string }, unknown] }[];
        const pinned = (c: (typeof calls)[number]) => typeof c.params?.[1] === "object" && c.params?.[1] !== null;
        if (calls.some((c) => c.method === "eth_call" && pinned(c) && refused.has(String(c.params?.[0]?.to ?? "").toLowerCase()))) {
          res.writeHead(429, { "content-type": "text/plain" });
          res.end("Too Many Requests");
          return;
        }
        const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body });
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(await r.text());
      });
    });
    await new Promise<void>((ok) => proxy.listen(PROXY_PORT, "127.0.0.1", ok));

    // readCircle reads balances from the app's USDG address: MockUSDG's code is placed there on the local anvil (as
    // tests/robinhood-read-in-turn-switch-adversary.spec.ts does)
    await pub.request({ method: "anvil_setCode", params: [USDG, artifact("MockUSDG.sol", "MockUSDG").runtime] } as never);
    const usdg = USDG;
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    // five circles the wallet created, its own seat not joined in any: on chain each is running and waits on the wallet
    const made: Address[] = [];
    for (let k = 0; k < 5; k++) {
      made.push((await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
        { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
          roundSecs: 60n, graceSecs: 30n },
        accounts.map((a) => a.address),
      ])) as Address);
    }
    refused.add(made[0]!.toLowerCase());

    // the chain's own answer, read straight from anvil with the app's readCircle: all five wait on this wallet
    const { readCircle } = await import(pathToFileURL(resolve(SRC, "lib/robinhood/adapter-core.ts")).href);
    const { rhToList } = await import(pathToFileURL(resolve(SRC, "lib/robinhood/to-list.ts")).href);
    const { circleCard } = await import(pathToFileURL(resolve(SRC, "lib/core/circle-card.ts")).href);
    for (const a of made) {
      const v = rhToList(await readCircle(pub, a, usdg), accounts[0]!.address);
      assert.equal(circleCard(v, accounts[0]!.address).group, "needs", `precondition: circle ${a} waits on the wallet on chain`);
    }

    const code = await pub.getCode({ address: factory });
    g.__a6rFactory = Object.freeze({ address: factory, codeHash: keccak256(code!) });
    g.__a6rClient = createPublicClient({ chain: { ...chain, rpcUrls: { default: { http: [PROXY] } } }, transport: http(undefined, { batch: true }) });
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
    // the factory check, the list read, then the five circle reads in turn (the refused one with its retries)
    for (let k = 0; k < 300 && !(source.found === 5 && source.reading === 0); k++) {
      await sleep(100);
      source = step();
    }
    assert.ok(source.blocked === null && !source.error, `precondition: the factory check and the list read passed (${String(source.error)}, found ${String(source.found)})`);
    assert.equal(source.found, 5, "precondition: the wallet's five circles were found");
    assert.equal(source.reading, 0, "precondition: every read has finished");
    assert.equal(source.failed.length, 1, "precondition: one read failed and is drawn as a failed row");
    assert.equal(source.circles.length, 4, "precondition: four circles were read");

    html = renderToStaticMarkup(React.createElement(CirclesHome, { source }));
    assert.ok(html.includes("Couldn&#x27;t read circle"), "precondition: the failed rows are drawn");
  });
  after(() => {
    anvil?.kill();
    proxy?.close();
  });

  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("the title row does not give an exact count of further running circles while one is unread", () => {
    const m = html.match(/>(\d+\+?) more running</);
    assert.ok(m, "precondition: the 'more running' button is drawn");
    assert.ok(m![1] !== "1",
      `the button says "${m![1]} more running": on chain 2 more are running (one of them unread), and it does not say so`);
  });
});
