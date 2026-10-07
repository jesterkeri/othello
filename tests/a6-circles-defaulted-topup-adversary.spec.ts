/**
 * Adversary on ec145a5 (PR #25, the shared circles list). Spec rule 1: "Each card's figures and next step match the
 * chain for that wallet (pay, claim, release, start, join, collect, top up)". ec145a5 gives every Paused card that is
 * not the recipient's the action "Top up" and the words "Any member can top up" (app/src/lib/core/circle-card.ts:70).
 * topUpReserve (evm/src/OthelloCircle.sol:426) refuses a seat settled in default (:429, AlreadyDefaulted), as does
 * Solana's top_up_reserve ("any member who has not defaulted"), so the defaulted member's card offers a step the chain
 * refuses that wallet.
 *
 * The state is reached on real contracts on a local anvil, by calls each member may make (the same sequence as
 * a6-circles-claim-gate-adversary): seat 1 receives round 1, misses round 2, is marked and declared in default; the
 * reserve then no longer covers the next payout, so round 2 is Paused. The card is read for seat 1, the defaulted one.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-defaulted-topup-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, http,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { readCircle, topUpFill } from "../app/src/lib/robinhood/adapter-core.ts";
import { rhToList } from "../app/src/lib/robinhood/to-list.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";

const U = 1_000_000n;
const PORT = 8711;
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

describe("Adversary on ec145a5: a defaulted member's Paused card offers a top-up the chain refuses (anvil, chain 46630)", function () {
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
  async function refusal(address: Address, abi: Abi, functionName: string, args: readonly unknown[], from: Address): Promise<string> {
    try {
      await pub.simulateContract({ address, abi, functionName, args, account: from } as never);
      return "";
    } catch (e) {
      const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      return r instanceof ContractFunctionRevertedError ? r.data?.errorName ?? "" : String(e);
    }
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

  it("seat 1, settled in default, is offered Top up while topUpReserve from seat 1 reverts AlreadyDefaulted", async () => {
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    const usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    // n 3, c 100, coverage 130%, no haircut, no minimum cover: peak need 260, so g 87 (reserve 261) passes createCircle
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
    await write(wallets[0]!, circle, abi, "releasePot"); // round 1 to seat 1

    // round 2: seat 1 (who has received) misses its payment; seats 2 and 3 pay; seat 1 is declared in default
    await write(wallets[1]!, circle, abi, "contribute");
    await write(wallets[2]!, circle, abi, "contribute");
    await pub.request({ method: "evm_increaseTime" as never, params: [200] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    await write(wallets[1]!, circle, abi, "markDelinquent", [1, 0]);
    await write(wallets[1]!, circle, abi, "declareDefault", [0]);

    const view = await readCircle(pub, circle, usdg);
    const me = accounts[0]!.address;
    const v = rhToList(view, me);
    assert.equal(v.status, "Active", "precondition: running");
    assert.equal(v.round, 1, "precondition: round 2, which seat 2 receives");
    assert.equal(v.seats[0]!.defaulted, true, "precondition: seat 1 (this wallet) is settled in default");
    assert.equal(v.releasable, true, "precondition: every seat paid or settled, escrow covers the defaulted share");
    assert.ok(v.pausedShortBy > 0n, `precondition: the chain's stored Paused figure is above 0 (${v.pausedShortBy})`);

    // the chain: a member not in default may top up; seat 1, in default, may not
    const amount = 1n * U;
    const fill = topUpFill(view.escrowDeficit, amount);
    assert.equal(await refusal(circle, abi, "topUpReserve", [amount, fill], accounts[2]!.address), "",
      "precondition: seat 3 (not in default) may top up");
    const mine = await refusal(circle, abi, "topUpReserve", [amount, fill], me);
    assert.equal(mine, "AlreadyDefaulted", "precondition: the chain refuses seat 1's top-up");

    const card = circleCard(v, me);
    assert.notEqual(card.action, "Top up",
      `seat 1's card reads "${card.headline}" with "${card.action}"; topUpReserve from seat 1 reverts ${mine}`);
  });
});
