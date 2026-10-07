/**
 * Adversary on 67d3214 (PR #25, the shared circles list). Spec rule 1: "Each card's figures ... match the chain". The
 * hero tile counts this round's payments twice, two ways: its sticker counts seats whose paid bit is set (HeroStickers,
 * app/src/components/circles/CircleCard.tsx: `s.paid`), and its seats summary counts paid OR "covered" (HeroSeats:
 * `payment === "paid" || payment === "covered"`). A seat settled in default has not paid this round (its paid bit is
 * clear until releasePot pays its share from the escrow, evm/src/OthelloCircle.sol:313-319), so with one such seat the
 * same tile says "2 of 3 paid" and "3 of 3 paid this round".
 *
 * The state is reached on real contracts on a local anvil by calls any member may make (the same path as
 * tests/a6-circles-claim-gate-adversary.spec.ts): seat 1 receives round 1, then misses round 2 and is declared in
 * default; seats 2 and 3 pay. The real CircleCard is rendered with react-dom/server from rhToList of that read.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-hero-paid-count-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  createPublicClient, createWalletClient, defineChain, http,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { REPO } from "./artifacts.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { readCircle } from "../app/src/lib/robinhood/adapter-core.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
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

const U = 1_000_000n;
const PORT = 8673;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

describe("Adversary on 67d3214: the hero tile gives two paid counts for one round (anvil, chain 46630)", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];

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
    pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(RPC) }));
  });
  after(() => anvil?.kill());

  it("one seat settled in default, two paid: the sticker and the seats summary agree on how many paid", async () => {
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    const usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
        roundSecs: 60n, graceSecs: 30n },
      accounts.map((a) => a.address),
    ])) as Address;
    const abi = othelloCircleAbi as Abi;
    for (const w of wallets) {
      await write(w, usdg, mock.abi, "approve", [circle, 1_000n * U]);
      await write(w, circle, abi, "joinAndLock", [1n]);
    }
    await write(wallets[0]!, circle, abi, "activate");
    for (const w of wallets) await write(w, circle, abi, "contribute");
    await write(wallets[0]!, circle, abi, "releasePot");
    await write(wallets[1]!, circle, abi, "contribute");
    await write(wallets[2]!, circle, abi, "contribute");
    await pub.request({ method: "evm_increaseTime" as never, params: [200] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    await write(wallets[1]!, circle, abi, "markDelinquent", [1, 0]);
    await write(wallets[1]!, circle, abi, "declareDefault", [0]);

    const view = await readCircle(pub, circle, usdg);
    const chainPaid = view.seats.filter((s) => s.paid).length;
    assert.equal(chainPaid, 2, "precondition: the chain has two seats paid this round");
    assert.ok(view.seats[0]!.defaulted && !view.seats[0]!.paid, "precondition: seat 1 is settled in default, not paid");

    const React = appRequire("react");
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { rhToList } = await import(pathToFileURL(resolve(SRC, "lib/robinhood/to-list.ts")).href);
    const { circleCard } = await import(pathToFileURL(resolve(SRC, "lib/core/circle-card.ts")).href);
    const { default: CircleCard } = await import(pathToFileURL(resolve(SRC, "components/circles/CircleCard.tsx")).href);

    const me = accounts[2]!.address;
    const v = rhToList(view, me);
    const html: string = renderToStaticMarkup(React.createElement(CircleCard,
      { v, me, card: circleCard(v, me), design: "hero", area: "a", tone: "" }));
    const counts = [...html.matchAll(/(\d+)<!-- --> of <!-- -->3<!-- --> paid|(\d+) of 3 paid/g)].map((m) => Number(m[1] ?? m[2]));
    assert.ok(counts.length >= 2, `precondition: the hero shows its paid counts (${counts.join(", ")})`);
    assert.deepEqual([...new Set(counts)], [chainPaid], `the hero tile says ${counts.map((n) => `${n} of 3 paid`).join(" and ")}; the chain has ${chainPaid}`);
  });
});
