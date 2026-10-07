/**
 * Adversary on 67d3214 (PR #25, the shared circles list). Spec rule 1: "Each card's figures and next step match the
 * chain for that wallet (... collect ...)". Once a member has collected from a finished circle, its card says
 * "You collected X". X is closeOutOf's per-seat total (app/src/lib/robinhood/circle-view.ts:118), seat.collateral plus
 * the pooled share, read after the fact. But withdraw() zeroes the seat's collateral (evm/src/OthelloCircle.sol:469,
 * `s.collateral = 0`), so the read taken after collecting has collateral 0 and the card names only the pooled share,
 * not what withdraw() paid.
 *
 * The state is reached on real contracts on a local anvil: three members join, the circle runs its three rounds to
 * Completed, and seat 2 collects. What the chain paid is the USDG balance change of that withdraw.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-collected-amount-adversary.spec.ts
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
import { fmtUsdg } from "../app/src/lib/core/money.ts";

const U = 1_000_000n;
const PORT = 8671;
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

describe("Adversary on 67d3214: a collected card names less than withdraw() paid (anvil, chain 46630)", function () {
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

  it("seat 2 collects from a completed circle; its card names the amount withdraw() paid", async () => {
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    const usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    // n 3, c 10, coverage 130%, no haircut, no minimum cover: peak need 26, so g 9 (reserve 27) passes createCircle
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      { n: 3n, c: 10n * U, g: 9n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
        roundSecs: 60n, graceSecs: 30n },
      accounts.map((a) => a.address),
    ])) as Address;
    const abi = othelloCircleAbi as Abi;
    for (const w of wallets) {
      await write(w, usdg, mock.abi, "approve", [circle, 1_000n * U]);
      await write(w, circle, abi, "joinAndLock", [20n * U]);
    }
    await write(wallets[0]!, circle, abi, "activate");
    for (let round = 0; round < 3; round++) {
      for (const w of wallets) await write(w, circle, abi, "contribute");
      await write(wallets[0]!, circle, abi, "releasePot");
    }

    const me = accounts[1]!.address;
    const balance = async () => (await pub.readContract({ address: usdg, abi: mock.abi, functionName: "balanceOf", args: [me] })) as bigint;
    const before = await balance();
    await write(wallets[1]!, circle, abi, "withdraw");
    const paid = (await balance()) - before;
    // what withdraw() paid: 20 USDG locked plus the pooled share 27 * 9 / 27 = 9 USDG
    assert.equal(paid, 29n * U, "precondition: withdraw() paid seat 2 its 20 USDG locked plus its 9 USDG reserve share");

    // the list, for seat 2, from the same read the page uses
    const view = await readCircle(pub, circle, usdg);
    assert.equal(view.status, "Completed", "precondition: the circle is finished");
    const card = circleCard(rhToList(view, me), me);
    assert.equal(card.group, "finished");
    // any amount the card names as collected must be the one withdraw() paid (naming none is also true)
    const named = /You collected ([\d,.]+ USDG)/.exec(card.headline)?.[1] ?? null;
    assert.ok(named === null || named === fmtUsdg(paid), `withdraw() paid ${fmtUsdg(paid)}; the card says "${card.headline}"`);
  });
});
