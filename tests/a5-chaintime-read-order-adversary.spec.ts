/**
 * Adversary on 885ecc6 (the page's late state, "Grace ended" and "Record missed payment" follow v.chainTime).
 *
 * Rule (Codex r1 on PR #22, answered by 885ecc6): the page must not show an unpaid seat as late, "Grace ended", or
 * offer "Record missed payment" before the chain itself is past grace, i.e. before OthelloCircle.markDelinquent can
 * succeed (evm/src/OthelloCircle.sol: block.timestamp > deadline + graceSecs, for the current round).
 *
 * Attack: readCircle (app/src/lib/robinhood/adapter-core.ts) reads the circle's state (round, deadline, paid bitmap)
 * in one batch at "latest", and only afterwards reads the latest block for chainTime. The two come from different
 * blocks. If, between the two, the last member pays inside grace and the pot is released, the view pairs the old
 * round's deadline and paid bitmap with a newer block's timestamp past that old grace. The chain was never past grace
 * with that seat unpaid, yet the page computes afterGrace and marks the seat late.
 *
 * Real contracts on a local anvil (chain id 46630), the same setup as tests/robinhood-adapter.spec.ts. The other
 * members' transactions are sent from inside the public client's getBlock, which is exactly the window between the
 * page's two reads. Needs `forge build` in evm/ first.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/a5-chaintime-read-order-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { createRobinhoodAdapterWith, readCircle } from "../app/src/lib/robinhood/adapter-core.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { ringOf } from "../app/src/lib/robinhood/circle-view.ts";

const PORT = 8597;
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
const GRACE = 30;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
function ok(r: { ok: boolean; error?: string; message?: string }, what: string) {
  assert.equal(r.ok, true, r.ok ? what : `${what}: ${r.error}: ${r.message}`);
}

describe("adversary 885ecc6: chainTime and the circle's state come from one block", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const wallets: WalletClient[] = [];
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    const hash = await w.writeContract({ ...(request as object), chain } as never);
    await pub.waitForTransactionReceipt({ hash });
    return result as unknown;
  }
  const rpc = (method: string, params: unknown[] = []) => pub.request({ method, params } as never);

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await sleep(100);
      }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(RPC) }));
  });
  after(() => anvil?.kill());

  it("the last member pays inside grace and the pot is released between the page's two reads: nobody is shown late", async () => {
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    const usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    const factoryHash = keccak256((await pub.getCode({ address: factory }))!);
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n,
        roundSecs: 60n, graceSecs: BigInt(GRACE) },
      accounts.map((a) => a.address),
    ])) as Address;
    const ads = accounts.map((a, i) => createRobinhoodAdapterWith({
      publicClient: pub, walletClient: wallets[i]!, account: a.address, circle, factory: { address: factory, codeHash: factoryHash }, usdg,
    }));
    for (const ad of ads) ok(await ad.joinAndLock({ amount: 20n * U }), "joinAndLock");
    ok(await ads[0]!.activate({}), "activate");
    ok(await ads[0]!.contribute({}), "seat 1 pays round 1");
    ok(await ads[1]!.contribute({}), "seat 2 pays round 1");
    const d = Number(await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "deadline" }));

    // The chain is 20 s inside round 1's grace; seat 3 has not paid yet.
    await rpc("evm_setNextBlockTimestamp", [d + GRACE - 20]);
    await rpc("evm_mine");

    // Between the page's state batch and its getBlock, seat 3 pays (still inside grace), seat 1 releases round 1's
    // pot (round 2 opens with a fresh deadline), and one more block is made 1 s after round 1's grace.
    let paidAt = 0;
    let fired = false;
    const page = {
      readContract: pub.readContract.bind(pub),
      getBlock: async (args: Parameters<PublicClient["getBlock"]>[0]) => {
        if (!fired) {
          fired = true;
          ok(await ads[2]!.contribute({}), "seat 3 pays round 1");
          paidAt = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
          ok(await ads[0]!.releasePot({}), "release round 1");
          await rpc("evm_setNextBlockTimestamp", [d + GRACE + 1]);
          await rpc("evm_mine");
        }
        return pub.getBlock(args);
      },
    } as unknown as PublicClient;

    const v = await readCircle(page, circle, usdg);
    assert.ok(paidAt <= d + GRACE, `precondition: seat 3 paid inside grace (paid at ${paidAt}, grace ends ${d + GRACE})`);

    // What the chain says at the block the page took its time from.
    const at = await pub.getBlock({ blockTag: "latest" });
    assert.equal(Number(at.timestamp), v.chainTime);
    const chainRound = Number(await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "round", blockNumber: at.number }));
    const chainDeadline = Number(await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "deadline", blockNumber: at.number }));
    assert.equal(chainRound, 1, "the chain is in round 2 (index 1)");
    assert.ok(v.chainTime <= chainDeadline + GRACE, "the chain is not past grace at that block");

    // The page's own expressions (RobinhoodCircle.tsx: chainNow = v.chainTime; afterGrace = chainNow > graceEnds;
    // ring = ringOf(v, w.address, chainNow)).
    const afterGrace = v.chainTime > v.deadline + v.graceSecs;
    const ring = ringOf(v, null, v.chainTime);
    const recordable = v.status === "Active" && afterGrace ? v.seats.filter((x) => !x.paid && !x.defaulted && !x.marked).map((x) => x.turn) : [];
    let recordReverts = "";
    for (const turn of recordable) {
      try {
        await pub.simulateContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "markDelinquent", args: [v.round, turn],
          account: accounts[0]!.address, blockNumber: at.number } as never);
      } catch (e) {
        recordReverts += `turn ${turn}: ${(e as Error).message.split("\n")[0]}; `;
      }
    }
    assert.deepEqual(
      { afterGrace, late: ring.seats.filter((x) => x.payment === "late").map((x) => x.turn), recordable },
      { afterGrace: false, late: [], recordable: [] },
      `the page shows "Grace ended" and offers Record missed payment for round ${v.round + 1}, which the chain at block ${at.number} `
        + `(round ${chainRound + 1}, grace ends ${chainDeadline + GRACE}, block time ${v.chainTime}) refuses: ${recordReverts}`,
    );
  });
});
