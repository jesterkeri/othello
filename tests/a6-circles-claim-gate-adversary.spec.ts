/**
 * Adversary on af41248 (PR #25, the shared circles list). Spec rule 1: "a Release/Claim is offered only when the chain
 * would accept it". releasePot (evm/src/OthelloCircle.sol:270) refuses a funded round when the payout gate fails
 * (ReserveOvercommitted / CoverageTooLow, :303-309). On Robinhood every input to that gate is in the read (each seat's
 * USDG collateral and roundsPaid, reserveTotal, reserveLosses; no price), so the list can know it. rhToList takes
 * `releasable` from releaseButton, which checks only payments and escrow, so the recipient's card says Claim and
 * counts in Needs-you while the chain refuses the release.
 *
 * The state is reached on real contracts on a local anvil, by calls any member may make: a default whose shortfall
 * the reserve absorbs (declareDefault, :369) leaves less reserve than the next recipient's gate needs.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-claim-gate-adversary.spec.ts
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
import { readCircle } from "../app/src/lib/robinhood/adapter-core.ts";
import { rhToList } from "../app/src/lib/robinhood/to-list.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";

const U = 1_000_000n;
const PORT = 8657;
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

describe("Adversary on af41248: the list offers Claim on a round the payout gate refuses (anvil, chain 46630)", function () {
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

  it("seat 2's card says Claim while releasePot reverts ReserveOvercommitted", async () => {
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

    // the chain: releasing round 2 is refused by the payout gate
    let refusal = "";
    try {
      await pub.simulateContract({ address: circle, abi, functionName: "releasePot", account: accounts[1]!.address } as never);
    } catch (e) {
      const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      refusal = r instanceof ContractFunctionRevertedError ? r.data?.errorName ?? "" : String(e);
    }
    assert.equal(refusal, "ReserveOvercommitted", "precondition: the chain refuses this round's release");

    // the list, for seat 2 (this round's recipient), from the same read the page uses
    const view = await readCircle(pub, circle, usdg);
    const card = circleCard(rhToList(view, accounts[1]!.address), accounts[1]!.address);
    assert.notEqual(card.action, "Claim", `the card offers "${card.headline}" (${card.group}) though releasePot reverts ${refusal}`);
  });
});
