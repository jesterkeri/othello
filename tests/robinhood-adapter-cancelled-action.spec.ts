/**
 * Adversary regression (2026-09-28): a join the member cancels in the wallet, after its approval confirmed,
 * must be reported as failed and must not leave the approval behind (ARB-DESIGN r9 section A: "Approvals are
 * for the exact amount of the action, never unlimited"; a failed action leaves no approval).
 *
 * Against the REAL contracts on a local anvil chain that uses Robinhood testnet's chain id (46630). Needs
 * `forge build` in evm/ first (reads evm/out).
 *
 *   npx mocha --import=tsx --timeout 120000 tests/robinhood-adapter-cancelled-action.spec.ts
 *
 * A wallet's "Cancel" on a pending transaction (MetaMask, Rabby) sends a 0-value transaction to the sender
 * itself with the same nonce and a higher fee. viem's waitForTransactionReceipt then resolves with the
 * receipt of that replacement (status "success"), reporting the reason only through `onReplaced`. The join
 * never ran, but the approval for collateral + g is still open.
 *
 * Second case, same rule: the approval is broadcast and later mines, but the adapter's wait for its receipt
 * throws first (viem's 180 s timeout on a slow RPC). `previous` is only assigned after approveExact returns,
 * so restore() does nothing and the message does not warn that an approval is open.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { createRobinhoodAdapterWith } from "../app/src/lib/robinhood/adapter-core.ts";

const PORT = 8593;
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

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

describe("A1 adversary: Robinhood adapter, action cancelled in the wallet (anvil, chain 46630)", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const wallets: WalletClient[] = [];
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const mock = artifact("MockUSDG.sol", "MockUSDG");
  let usdg: Address;
  let factory: Address;
  let factoryHash: Hex;

  const rpc = (method: string, params: unknown[] = []) =>
    (pub as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method, params });

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

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC) });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await sleep(100);
      }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(RPC) }));
    usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    factoryHash = keccak256((await pub.getCode({ address: factory }))!);
  });

  after(() => {
    anvil?.kill();
  });

  it("a join cancelled in the wallet is not reported done and leaves no allowance behind", async () => {
    const members = accounts.map((a) => a.address);
    // same parameters as tests/robinhood-adapter.spec.ts circle A
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      {
        n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n,
        warnBps: 11000n, roundSecs: 60n, graceSecs: 30n,
      },
      members,
    ])) as Address;

    const member = wallets[1]!;
    const me = accounts[1]!.address;
    let cancelled: Hex | null = null;
    let background: Promise<void> = Promise.resolve();

    // Member 1's wallet. The approval goes through as normal. The join is broadcast and sits pending; the
    // member then presses "Cancel" in the wallet, which replaces it with a 0-value self-send at the same
    // nonce and a higher fee, and that replacement is what gets mined.
    const cancelling = {
      ...member,
      writeContract: async (req: { address: Address }) => {
        if (req.address.toLowerCase() !== circle.toLowerCase()) return member.writeContract(req as never);
        const nonce = await pub.getTransactionCount({ address: me, blockTag: "pending" });
        const fees = await pub.estimateFeesPerGas();
        await rpc("evm_setAutomine", [false]);
        const hash = await member.writeContract(req as never);
        background = (async () => {
          // after the adapter's waitForTransactionReceipt has seen the pending join
          await sleep(1_500);
          cancelled = await member.sendTransaction({
            account: member.account!, chain, to: me, value: 0n, nonce,
            maxFeePerGas: fees.maxFeePerGas! * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas! * 3n + 1n,
          });
          await rpc("evm_setAutomine", [true]);
          await rpc("evm_mine");
        })();
        return hash;
      },
    } as unknown as WalletClient;

    const ad = createRobinhoodAdapterWith({
      publicClient: pub, walletClient: cancelling, account: me, circle,
      factory: { address: factory, codeHash: factoryHash }, usdg,
    });

    const r = await ad.joinAndLock({ amount: 20n * U });
    await background;

    // Sanity: the chain agrees the join never happened and the cancel is what was mined.
    assert.ok(cancelled, "the wallet's cancel was sent");
    const joined = (await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "joinedBitmap" })) as number;
    assert.equal(joined & 0b10, 0, "seat 1 did not join: the join transaction was replaced by the cancel");
    const receipt = await pub.getTransactionReceipt({ hash: cancelled! });
    assert.equal(receipt.status, "success");

    const allowance = (await pub.readContract({
      address: usdg, abi: mock.abi, functionName: "allowance", args: [me, circle],
    })) as bigint;
    assert.equal(allowance, 0n, "the join pulled 0 USDG, so no approval may remain for it");
    assert.equal(r.ok, false, "a join that never ran must not be reported as done");
  });

  it("an approval whose receipt wait times out, then mines, is not left behind silently", async () => {
    const members = accounts.map((a) => a.address);
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      {
        n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n,
        warnBps: 11000n, roundSecs: 60n, graceSecs: 30n,
      },
      members,
    ])) as Address;
    const me = accounts[2]!.address;

    // A slow RPC: the approval is broadcast and mines, but the first receipt wait gives up the way viem's
    // does after its 180 s default (WaitForTransactionReceiptTimeoutError). Later receipts come back normally.
    let waits = 0;
    let approval: Hex | null = null;
    const slow = {
      ...pub,
      waitForTransactionReceipt: async (a: { hash: Hex }) => {
        if (++waits === 1) {
          approval = a.hash;
          const e = new Error(`Timed out while waiting for transaction with hash "${a.hash}" to be confirmed.`);
          e.name = "WaitForTransactionReceiptTimeoutError";
          throw e;
        }
        return pub.waitForTransactionReceipt(a);
      },
    } as unknown as PublicClient;

    const ad = createRobinhoodAdapterWith({
      publicClient: slow, walletClient: wallets[2]!, account: me, circle,
      factory: { address: factory, codeHash: factoryHash }, usdg,
    });
    const r = await ad.joinAndLock({ amount: 20n * U });

    assert.equal(r.ok, false, "the adapter gave up on the join");
    // the approval the adapter stopped waiting for does mine
    assert.ok(approval, "the approval was broadcast");
    assert.equal((await pub.waitForTransactionReceipt({ hash: approval! })).status, "success", "the approval mined");
    const joined = (await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "joinedBitmap" })) as number;
    assert.equal(joined & 0b100, 0, "seat 2 did not join");
    const allowance = (await pub.readContract({
      address: usdg, abi: mock.abi, functionName: "allowance", args: [me, circle],
    })) as bigint;
    const warned = !r.ok && /still open in your wallet/.test(r.message);
    assert.ok(
      allowance === 0n || warned,
      `the join pulled 0 USDG, yet ${allowance} base units stay approved and the message says nothing: "${!r.ok ? r.message : ""}"`,
    );
  });
});
