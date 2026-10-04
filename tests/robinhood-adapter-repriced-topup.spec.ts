/**
 * Codex code review r2 (MAJOR): a normal wallet "Speed up" of a top-up that succeeds must be reported as the
 * top-up's success, exactly once; it must not say "did not run" (the member would pay again). ARB-DESIGN r9
 * section A and 3.6. Against the REAL contracts on anvil with Robinhood testnet's chain id. Needs `forge build`.
 *
 *   npx mocha --import=tsx --timeout 120000 tests/robinhood-adapter-repriced-topup.spec.ts
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

const PORT = 8594;
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

describe("Codex r2: a wallet speed-up of a top-up (anvil, chain 46630)", function () {
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

  it("a sped-up top-up (same call, higher fee) is reported as done, applied once, no approval left", async () => {
    const [a0, a1, a2] = accounts;
    const members = accounts.map((a) => a.address);
    const p = { n: 3n, c: 1n * U, g: 1n * U, minStockCover: 1n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n,
      roundSecs: 60n, graceSecs: 30n };
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [p, members])) as Address;
    const pinned = { address: factory, codeHash: factoryHash };
    const ad = (i: number, w: WalletClient = wallets[i]!) =>
      createRobinhoodAdapterWith({ publicClient: pub, walletClient: w, account: accounts[i]!.address, circle, factory: pinned, usdg });
    for (let i = 0; i < 3; i++) assert.equal((await ad(i).joinAndLock({ amount: 2n * U })).ok, true);
    assert.equal((await ad(0).activate({})).ok, true);

    const me = a1!;
    const balBefore = (await pub.readContract({ address: usdg, abi: mock.abi, functionName: "balanceOf", args: [me.address] })) as bigint;
    let speedUpError: unknown = null;
    await rpc("evm_setAutomine", [false]);
    try {
      const real = wallets[1]!;
      const wallet = {
        chain,
        account: real.account,
        getChainId: () => real.getChainId(),
        writeContract: async (req: { functionName?: string }) => {
          const hash = await real.writeContract(req as never);
          if (req.functionName === "topUpReserve") {
            void (async () => {
              await sleep(1_500); // the page is waiting on the pending top-up
              const tx = await pub.getTransaction({ hash });
              // "Speed up": identical to, data and value, same nonce, higher fees (priority never above max fee)
              const bump = 2_000_000_000n;
              await real.sendTransaction({
                account: me, chain, to: tx.to!, data: tx.input, value: tx.value, nonce: tx.nonce, gas: tx.gas,
                maxFeePerGas: tx.maxFeePerGas! * 3n + bump, maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 1n) * 3n + bump / 2n,
              });
              await rpc("evm_mine");
            })().catch((e) => { speedUpError = e; void rpc("evm_mine"); });
          } else {
            void (async () => { await sleep(300); await rpc("evm_mine"); })(); // the approval mines normally
          }
          return hash;
        },
      } as unknown as WalletClient;
      const r = await ad(1, wallet).topUpReserve({ amount: 3n * U, expectedFill: 0n });
      assert.equal(speedUpError, null, `the test's speed-up itself failed: ${String(speedUpError)}`);
      assert.equal(r.ok, true, r.ok ? "" : `adapter said ${r.error}: "${r.message}" for a sped-up top-up that ran`);
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    const seat = (await pub.readContract({ address: circle, abi: othelloCircleAbi, functionName: "seat", args: [1n] })) as { topUps: bigint };
    assert.equal(seat.topUps, 3n * U, "exactly one top-up applied");
    const balAfter = (await pub.readContract({ address: usdg, abi: mock.abi, functionName: "balanceOf", args: [me.address] })) as bigint;
    assert.equal(balBefore - balAfter, 3n * U, "paid exactly once");
    const allowance = (await pub.readContract({ address: usdg, abi: mock.abi, functionName: "allowance", args: [me.address, circle] })) as bigint;
    assert.equal(allowance, 0n, "no approval left");
    void a0; void a2;
  });
});
