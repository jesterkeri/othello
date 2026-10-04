/**
 * Adversary regression (2026-09-28): a refused action after its approval confirmed must not leave the
 * approval behind (ARB-DESIGN r9 section A: approvals for the exact amount of the action).
 *
 * A1 adversary: the Robinhood adapter's approvals (ARB-DESIGN r9 section A, "Approvals are for the exact
 * amount of the action, never unlimited"), against the REAL contracts on a local anvil chain that uses
 * Robinhood testnet's chain id (46630). Needs `forge build` in evm/ first (reads evm/out).
 *
 *   npx mocha --import=tsx --timeout 120000 tests/robinhood-adapter-leftover-approval.spec.ts
 *
 * The adapter approves, waits for the approval, then sends the action. If the circle changes in that
 * window (here: the creator cancels while a member's join approval is confirming), the action is refused
 * and pulls nothing, but the approval it asked for stays on the chain.
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

const PORT = 8592;
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

describe("A1 adversary: Robinhood adapter approvals (anvil, chain 46630)", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const wallets: WalletClient[] = [];
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const mock = artifact("MockUSDG.sol", "MockUSDG");
  let usdg: Address;
  let factory: Address;
  let factoryHash: Hex;

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

  it("a join refused after its approval confirmed leaves no allowance behind", async () => {
    const members = accounts.map((a) => a.address);
    // same parameters as tests/robinhood-adapter.spec.ts circle A
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      {
        n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n,
        warnBps: 11000n, roundSecs: 60n, graceSecs: 30n,
      },
      members,
    ])) as Address;

    // Member 1's view of the chain. After the approval's receipt comes back (and before the adapter sends
    // the join), the creator cancels the circle: an ordinary transaction by another member.
    let receipts = 0;
    const racing = {
      ...pub,
      waitForTransactionReceipt: async (a: { hash: Hex }) => {
        const r = await pub.waitForTransactionReceipt(a);
        if (++receipts === 1) await write(wallets[0]!, circle, othelloCircleAbi as Abi, "cancelCircle");
        return r;
      },
    } as unknown as PublicClient;

    const ad = createRobinhoodAdapterWith({
      publicClient: racing, walletClient: wallets[1]!, account: accounts[1]!.address, circle,
      factory: { address: factory, codeHash: factoryHash }, usdg,
    });
    const before = (await pub.readContract({
      address: usdg, abi: mock.abi, functionName: "balanceOf", args: [accounts[1]!.address],
    })) as bigint;

    const r = await ad.joinAndLock({ amount: 20n * U });

    // Two receipts and no join transaction: the approval, then (after the join is refused before sending)
    // the approval set back to its earlier value.
    assert.equal(receipts, 2, "the approval, then its reset; the join itself was never sent");
    assert.match(!r.ok ? r.message : "", /set back, so nothing is left approved/);
    assert.equal(!r.ok && r.error, "CircleNotForming", "the join itself was refused");
    assert.equal(
      (await pub.readContract({ address: usdg, abi: mock.abi, functionName: "balanceOf", args: [accounts[1]!.address] })) as bigint,
      before,
      "nothing was pulled",
    );
    const allowance = (await pub.readContract({
      address: usdg, abi: mock.abi, functionName: "allowance", args: [accounts[1]!.address, circle],
    })) as bigint;
    assert.equal(allowance, 0n, "the action pulled 0 USDG, so no approval may remain for it");
  });
});
