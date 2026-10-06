/**
 * Adversary on e47ffbe: a release whose transaction is sped up (repriced) or cancelled in the wallet. A speed-up is the
 * same release, so its receipt's PotReleased must still name the round and seat; a cancel did not release, so nothing
 * may be reported as released.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a5-release-repriced-attribution-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { createRobinhoodAdapterWith } from "../app/src/lib/robinhood/adapter-core.ts";

const U = 1_000_000n;
const PORT = 8653;
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
function ok(r: { ok: boolean; error?: string; message?: string }, what: string) {
  assert.equal(r.ok, true, r.ok ? what : `${what}: ${r.error}: ${r.message}`);
}

describe("adversary on e47ffbe: a sped-up or cancelled release (anvil, chain 46630)", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  const sentFirst: Hex[] = [];

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...(request as object), chain } as never) });
    return result as unknown;
  }

  async function setup() {
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    const usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    const factoryHash = keccak256((await pub.getCode({ address: factory }))!);
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n,
        roundSecs: 3600n, graceSecs: 600n },
      accounts.map((a) => a.address),
    ])) as Address;
    const trusted = { address: factory, codeHash: factoryHash };
    const ads = accounts.map((a, i) => createRobinhoodAdapterWith({ publicClient: pub, walletClient: wallets[i]!, account: a.address, circle, factory: trusted, usdg }));
    for (const ad of ads) ok(await ad.joinAndLock({ amount: 20n * U }), "joinAndLock");
    ok(await ads[0]!.activate({}), "activate");
    for (const ad of ads) ok(await ad.contribute({}), "pay round 1");
    return { circle, trusted, usdg };
  }

  /** A wallet that sends the release, then (after the adapter has seen it pending) replaces it with `second`. */
  function replacing(w: WalletClient, second: (nonce: number, fee: bigint) => Promise<Hex>): WalletClient {
    return Object.assign(Object.create(Object.getPrototypeOf(w)), w, {
      writeContract: async (req: Parameters<WalletClient["writeContract"]>[0]) => {
        await test.setAutomine(false);
        const nonce = await pub.getTransactionCount({ address: w.account!.address, blockTag: "pending" });
        const fee = 2_000_000_000n;
        const first = await w.sendTransaction({
          to: (req as { address: Address }).address,
          data: encodeFunctionData(req as never),
          gas: (req as { gas: bigint }).gas, nonce, maxFeePerGas: fee, maxPriorityFeePerGas: fee / 2n, chain,
        } as never);
        void (async () => {
          await sleep(1_500);
          await second(nonce, fee * 3n);
          await sleep(200);
          await test.mine({ blocks: 1 });
          await test.setAutomine(true);
        })();
        sentFirst.push(first);
        return first;
      },
    }) as WalletClient;
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

  it("a speed-up is the same release: the result names round 1, Seat 1, from the replacement's receipt", async () => {
    const { circle, trusted, usdg } = await setup();
    const w = wallets[2]!;
    const data = encodeFunctionData({ abi: othelloCircleAbi as Abi, functionName: "releasePot", args: [] });
    const sped = replacing(w, (nonce, fee) => w.sendTransaction({
      to: circle, data, gas: 2_000_000n, nonce, maxFeePerGas: fee, maxPriorityFeePerGas: fee / 2n, chain,
    } as never));
    const b = createRobinhoodAdapterWith({ publicClient: pub, walletClient: sped, account: accounts[2]!.address, circle, factory: trusted, usdg });
    const out = await b.releasePot({});
    ok(out, "sped-up release");
    assert.ok(out.ok && out.released, "a repriced release still carries its receipt's PotReleased");
    assert.deepEqual(out.ok && { round: out.released!.round, recipient: out.released!.recipient },
      { round: 0, recipient: accounts[0]!.address });
    assert.notEqual(out.ok && out.txHash, sentFirst.at(-1), "precondition: the receipt is the speed-up's, not the first send's");
  });

  it("a cancel did not release: no success and nothing named", async () => {
    const { circle, trusted, usdg } = await setup();
    const w = wallets[2]!;
    const cancelled = replacing(w, (nonce, fee) => w.sendTransaction({
      to: accounts[2]!.address, value: 0n, nonce, maxFeePerGas: fee, maxPriorityFeePerGas: fee / 2n, chain,
    } as never));
    const b = createRobinhoodAdapterWith({ publicClient: pub, walletClient: cancelled, account: accounts[2]!.address, circle, factory: trusted, usdg });
    const out = await b.releasePot({});
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.error, "Replaced");
    const round = Number(await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "round" }));
    assert.equal(round, 0, "precondition: the cancel left round 1 unreleased");
  });
});
