/**
 * Adversary on 60f4a3b (PR #25, the shared circles list). Spec rule 1: "Each card's figures and next step match the
 * chain for that wallet (pay, claim, start, join, collect, top up, release)". releasePot
 * (evm/src/OthelloCircle.sol:270) is callable by any address once every seat has paid or been settled and the gate
 * passes, so a member who is not this round's recipient can release the pot. circleCard
 * (app/src/lib/core/circle-card.ts) has no release branch: for that member a funded, unpaused round reads only
 * "Round 1 of 3: Seat 1 receives 300 USDG" with "Open circle", so the list never names release as a next step.
 *
 * The state is reached on real contracts on a local anvil by calls each member makes for itself: three seats join,
 * the creator starts the circle, every seat pays round 1. Nobody has released yet.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-release-step-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, http,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { readCircle } from "../app/src/lib/robinhood/adapter-core.ts";
import { rhToList } from "../app/src/lib/robinhood/to-list.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";

const U = 1_000_000n;
const PORT = 8693;
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

describe("Adversary on 60f4a3b: a member who may release a funded round is never told so (anvil, chain 46630)", function () {
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

  it("seat 2's card names release while releasePot from seat 2 would be accepted", async () => {
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
    for (const w of wallets) await write(w, circle, abi, "contribute");

    // the chain: seat 2 (not this round's recipient) may release round 1's pot now
    await pub.simulateContract({ address: circle, abi, functionName: "releasePot", account: accounts[1]!.address } as never);

    const view = await readCircle(pub, circle, usdg);
    const me = accounts[1]!.address;
    const v = rhToList(view, me);
    assert.equal(v.status, "Active", "precondition: running");
    assert.equal(v.round, 0, "precondition: round 1, which seat 1 receives");
    assert.equal(v.releasable, true, "precondition: the list itself knows the round can be released");
    assert.equal(v.pausedShortBy, 0n, "precondition: not Paused");

    const card = circleCard(v, me);
    assert.match(`${card.headline} | ${card.action}`, /release/i,
      `seat 2's card reads "${card.headline}" with "${card.action}"; the chain accepts seat 2's releasePot now`);
  });
});
