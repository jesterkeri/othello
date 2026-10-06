/**
 * Adversary on c5d7863 (readCircle reads the latest block first and pins every state read to its number).
 *
 * Rule: readCircle returns one snapshot; every field and chainTime describe the same block, and chainTime is that
 * block's timestamp. The page shows an unpaid seat late, "Grace ended" and "Record missed payment" only when the chain
 * at the view's block is past deadline + graceSecs (evm/src/OthelloCircle.sol markDelinquent).
 *
 * Attack: the state reads are pinned by block NUMBER, not by block hash. If block N (the one getBlock returned, whose
 * timestamp becomes chainTime) is replaced by another block N before the pinned eth_calls run (a reorg), the state
 * comes from the new block N and the time from the orphaned one. Here the orphaned N is 1 s past grace and the
 * canonical N is 10 s inside it, with seat 3 unpaid in both: the chain at the block the state was read from is not
 * past grace and refuses markDelinquent, yet the view says "Grace ended" and offers Record missed payment.
 *
 * Fixed after c5d7863: readCircle checks block N's hash again after its reads and reads again when it changed; this
 * test now requires that retry to return the canonical block's view (removing the hash check fails it).
 *
 * Real contracts on a local anvil (chain id 46630). The reorg is evm_snapshot / evm_revert around the mined block,
 * done inside the public client's getBlock, i.e. right after the page took its block. Needs `forge build` in evm/.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/a5-chaintime-reorg-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, http, keccak256,
  type Abi, type Address, type Block, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { createRobinhoodAdapterWith, readCircle } from "../app/src/lib/robinhood/adapter-core.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { ringOf } from "../app/src/lib/robinhood/circle-view.ts";

const PORT = 8611;
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

describe("adversary c5d7863: a reorg between readCircle's getBlock and its pinned reads", function () {
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

  it("block N is replaced after the page took it: the view's time and its state come from the same block", async () => {
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

    // The chain is 20 s inside round 1's grace; seat 3 has not paid.
    await rpc("evm_setNextBlockTimestamp", [d + GRACE - 20]);
    await rpc("evm_mine");

    // The page takes block N (1 s past grace). Before its pinned reads run, N is reorged out and replaced by a
    // different block N, 10 s inside grace. Nothing else changes: seat 3 is unpaid in both.
    let orphan: Block | undefined;
    const page = {
      readContract: pub.readContract.bind(pub),
      getBlock: async (args: Parameters<PublicClient["getBlock"]>[0]) => {
        if (orphan) return pub.getBlock(args);
        const snap = await rpc("evm_snapshot");
        await rpc("evm_setNextBlockTimestamp", [d + GRACE + 1]);
        await rpc("evm_mine");
        orphan = await pub.getBlock(args);
        await rpc("evm_revert", [snap]);
        await rpc("evm_setNextBlockTimestamp", [d + GRACE - 10]);
        await rpc("evm_mine");
        return orphan;
      },
    } as unknown as PublicClient;

    // Refusing to answer would also keep the screen truthful; readCircle (fix on c5d7863) sees block N's hash change
    // after its reads and reads again, so it must return the canonical block's view.
    const v = await readCircle(page, circle, usdg);

    const canon = await pub.getBlock({ blockNumber: orphan!.number! });
    assert.notEqual(canon.hash, orphan!.hash, "precondition: block N was replaced");
    assert.equal(Number(orphan!.timestamp), d + GRACE + 1, "precondition: the orphaned N is past grace");
    assert.equal(Number(canon.timestamp), d + GRACE - 10, "precondition: the canonical N is inside grace");

    // The view's time is a canonical block's, never the orphaned N's. After the failed read, readCircle (fix pass on
    // 9343ef9) reads again one block back, so the view is the canonical N-1 here; the canonical N is also correct.
    const prev = await pub.getBlock({ blockNumber: orphan!.number! - 1n });
    assert.ok([Number(canon.timestamp), Number(prev.timestamp)].includes(v.chainTime),
      `the view's time ${v.chainTime} is not a canonical block's (N ${canon.timestamp}, N-1 ${prev.timestamp})`);
    // The page's own expressions (RobinhoodCircle.tsx: chainNow = v.chainTime; afterGrace = chainNow > graceEnds).
    const afterGrace = v.chainTime > v.deadline + v.graceSecs;
    const ring = ringOf(v, null, v.chainTime);
    const recordable = v.status === "Active" && afterGrace ? v.seats.filter((x) => !x.paid && !x.defaulted && !x.marked).map((x) => x.turn) : [];
    let recordReverts = "";
    for (const turn of recordable) {
      try {
        await pub.simulateContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "markDelinquent", args: [v.round, turn],
          account: accounts[0]!.address, blockNumber: canon.number } as never);
      } catch (e) {
        recordReverts += `turn ${turn}: ${(e as Error).message.split("\n")[0]}; `;
      }
    }
    assert.deepEqual(
      { afterGrace, late: ring.seats.filter((x) => x.payment === "late").map((x) => x.turn), recordable },
      { afterGrace: false, late: [], recordable: [] },
      `the view pairs the orphaned block's time (${orphan!.timestamp}) with state read at block ${canon.number} `
        + `(canonical time ${canon.timestamp}, grace ends ${d + GRACE}); the chain there refuses: ${recordReverts}`,
    );
  });
});
