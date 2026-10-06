/**
 * Adversary on 0908465 (readCircle pins its reads to block N's NUMBER, then checks block N's hash once more after the
 * reads and returns the view when the hash is the one it started with).
 *
 * Rule: readCircle returns one snapshot; every field (status, round, deadline, bitmaps, seat structs, members, USDG
 * balance, totals) and chainTime describe the same canonical block. A transaction or a reorg during the read must never
 * produce a view mixing two blocks; if no consistent snapshot can be taken it must fail rather than return a mixed view.
 *
 * Attack: a hash check before and after the reads cannot see a reorg that happens and is undone in between (A, then
 * B, then A again at height N). The circle's state batch is read at A, the second batch (members, seat structs, USDG
 * balance) at B, and by the time the hash is checked again A is canonical once more, so the mixed view is returned.
 * Here A is an empty block (seat 3 unpaid) and B is the same height with seat 3's contribute: the view takes
 * `accounted` from A and `balance` from B, so `surplus` is 10 USDG that exists at no block, and the page shows
 * "10 USDG was sent to this circle by mistake" (RobinhoodCircle.tsx, v.surplus > 0n).
 *
 * Fixed after 0908465: readCircle pins every read to block A's hash with requireCanonical (EIP-1898), so a read while
 * B is canonical fails instead of answering from B; the read is refused and the page keeps its last view until the
 * next read. Failed on 0908465 (pinned by number), passes now.
 *
 * Real contracts on a local anvil (chain id 46630). A is re-mined identically (same parent, same timestamp, no
 * transactions), so its hash is the same; a precondition asserts that. Needs `forge build` in evm/.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a5-chaintime-aba-reorg-adversary.spec.ts
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

const PORT = 8617;
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

describe("adversary 0908465: a reorg that is undone while readCircle reads (A, B, A at the same height)", function () {
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

  it("A is replaced by B for the second batch and restored before the hash check: the view is one block, or an error", async () => {
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
    // Seat 3 approves now, so its payment later is one transaction in one block.
    await write(wallets[2]!, usdg, mock.abi, "approve", [circle, 10n * U]);
    const d = Number(await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "deadline" }));
    const now = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);

    // Block A at height N: empty, inside round 1, seat 3 unpaid.
    const t = Math.min(d - 5, now + 2);
    const base = await rpc("evm_snapshot");
    await rpc("evm_setNextBlockTimestamp", [t]);
    await rpc("evm_mine");
    const a = await pub.getBlock({ blockTag: "latest" });

    let phase: "A" | "B" | "A again" = "A";
    let b: Block | undefined;
    let snap = base;
    let toB: Promise<void> | undefined;
    const page = {
      readContract: async (args: Parameters<PublicClient["readContract"]>[0]) => {
        if (phase === "A" && (args as { functionName: string }).functionName === "members") {
          // The state batch has been read at A. Reorg: A is replaced by B, the same height with seat 3's payment.
          // Every read of the second batch waits until B is mined.
          phase = "B";
          toB = (async () => {
            await rpc("evm_revert", [snap]);
            snap = await rpc("evm_snapshot");
            await rpc("evm_setNextBlockTimestamp", [t]);
            await write(wallets[2]!, circle, othelloCircleAbi as Abi, "contribute");
            b = await pub.getBlock({ blockTag: "latest" });
          })();
        }
        if (toB) await toB;
        return pub.readContract(args as never);
      },
      getBlock: async (args: Parameters<PublicClient["getBlock"]>[0]) => {
        if (phase === "B" && args && "blockNumber" in args) {
          // Reorg back: B is dropped and A is the canonical block at height N again.
          phase = "A again";
          await rpc("evm_revert", [snap]);
          await rpc("evm_setNextBlockTimestamp", [t]);
          await rpc("evm_mine");
        }
        const got = await pub.getBlock(args);
        if (process.env.ABA_DEBUG) console.log("getBlock", phase, got.number, got.hash, "A", a.hash);
        return got;
      },
    } as unknown as PublicClient;

    let v: Awaited<ReturnType<typeof readCircle>>;
    try {
      v = await readCircle(page, circle, usdg);
    } catch (e) {
      // Refusing to answer keeps the screen truthful, but only once the harness really ran A, B, A.
      assert.equal(phase, "A again", `the harness failed before the reorg back to A: ${(e as Error).message.split("\n")[0]}`);
      return;
    }

    const canon = await pub.getBlock({ blockTag: "latest" });
    assert.equal(phase, "A again", "precondition: the reorg to B and back to A happened during the read");
    assert.ok(b && b.number === a.number && b.hash !== a.hash, "precondition: B was a different block at A's height");
    assert.equal(canon.hash, a.hash, "precondition: A is canonical again with the same hash");
    const truth = await readCircle(pub, circle, usdg);
    assert.equal(truth.chainTime, v.chainTime, "precondition: the clean read is at block A too");

    const pick = (x: typeof v) => ({
      balance: x.balance, surplus: x.surplus, escrow: x.escrow, depositsTotal: x.depositsTotal,
      paid3: x.seats[2]!.paid, roundsPaid3: x.seats[2]!.roundsPaid,
    });
    assert.deepEqual(pick(v), pick(truth),
      `the view mixes block A's state batch with block B's seats and balance (B ${b!.hash}, A ${a.hash}); `
        + `surplus ${v.surplus} would show as sent by mistake`);
  });
});
