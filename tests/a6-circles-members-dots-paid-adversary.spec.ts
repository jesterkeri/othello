/**
 * Adversary on 60f4a3b (PR #25, the shared circles list). Spec rule 1: "every amount, count and seat marking shown
 * agrees with the chain". The members tile's seat dots (SeatDots, app/src/components/circles/CircleCard.tsx) are
 * documented as "Each seat as a segment, filled in its ring colour once it has paid this round (joined, while
 * forming)", but are filled by the joined bit in every status. In a running circle every seat has joined, so every dot
 * is drawn filled, as paid, while the chain has no seat paid this round.
 *
 * The state is reached on real contracts on a local anvil: three seats join and the creator starts the circle; nobody
 * has paid round 1. The real CircleCard is rendered with react-dom/server (members design) from rhToList of that read.
 * Own process: it installs module loader hooks.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-members-dots-paid-adversary.spec.ts
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
const PORT = 8695;
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

describe("Adversary on 60f4a3b: the members tile draws every seat of a running circle as paid (anvil, chain 46630)", function () {
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

  it("no seat has paid round 1: no seat dot is filled as paid", async () => {
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
      await write(w, circle, abi, "joinAndLock", [100n * U]);
    }
    await write(wallets[0]!, circle, abi, "activate");

    const view = await readCircle(pub, circle, usdg);
    assert.equal(view.status, "Active", "precondition: running");
    const chainPaid = view.seats.filter((s) => s.paid).length;
    assert.equal(chainPaid, 0, "precondition: no seat has paid round 1");

    const React = appRequire("react");
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { rhToList } = await import(pathToFileURL(resolve(SRC, "lib/robinhood/to-list.ts")).href);
    const { circleCard } = await import(pathToFileURL(resolve(SRC, "lib/core/circle-card.ts")).href);
    const { default: CircleCard } = await import(pathToFileURL(resolve(SRC, "components/circles/CircleCard.tsx")).href);

    const me = accounts[1]!.address;
    const v = rhToList(view, me);
    const html: string = renderToStaticMarkup(React.createElement(CircleCard,
      { v, me, card: circleCard(v, me), design: "members", area: "c", tone: "" }));
    // the CSS module stub names each class by its key: a seat dot is "dot ...", the overflow counter "dot dotMore"
    const dots = [...html.matchAll(/<span class="dot (?!dotMore)[^"]*"( style="[^"]*")?>/g)];
    assert.equal(dots.length, 3, `precondition: three seat dots drawn (${dots.length})`);
    const filled = dots.filter((m) => /background/.test(m[1] ?? "")).length;
    assert.equal(filled, chainPaid, `the members tile fills ${filled} of 3 seat dots as paid; the chain has ${chainPaid} paid this round`);
  });
});
