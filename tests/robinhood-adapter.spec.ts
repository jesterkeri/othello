/**
 * ARB-DESIGN r9 section 7.1 rows "trusted-circle route (app)", "adapter split (r8)", "consent capability
 * (r7)" and the adapter end to end, against the REAL contracts on a local anvil chain that uses Robinhood
 * testnet's chain id (46630). Needs `forge build` in evm/ first (reads evm/out).
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx tests/robinhood-adapter.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { toCommon, type SolanaAdapter } from "../app/src/lib/core/adapter.ts";
import { ACTION_ARGS, InvalidArguments, checked } from "../app/src/lib/core/profiles.ts";
import { checkTrusted, createRobinhoodAdapter, readCircle, topUpFill } from "../app/src/lib/robinhood/adapter.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";

const PORT = 8591;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

const U = 1_000_000n;

/** Asserts success and, if not, says which action failed and why (so a failure names itself). */
function ok(r: { ok: boolean; error?: string; message?: string }, what: string) {
  assert.equal(r.ok, true, r.ok ? what : `${what}: ${r.error}: ${r.message}`);
}
const params = (over: Partial<Record<string, bigint>> = {}) => ({
  n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n,
  roundSecs: 60n, graceSecs: 30n, ...over,
});

describe("Robinhood adapter against the real contracts (anvil, chain 46630)", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const wallets: WalletClient[] = [];
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let usdg: Address;
  let factory: Address;
  let factoryHash: Hex;
  let circleA: Address;
  let circleB: Address;

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
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
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    factoryHash = keccak256((await pub.getCode({ address: factory }))!);
    const members = accounts.map((a) => a.address);
    circleA = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [params(), members])) as Address;
    // second legitimate circle: other creator and other c, g, timing, haircut
    circleB = (await write(wallets[1]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      params({ c: 3n * U, g: 9n * U, roundSecs: 3600n, graceSecs: 600n, haircutBps: 0n, minStockCover: 1n * U }),
      [members[1], members[0], members[2]],
    ])) as Address;
  });

  after(() => {
    anvil?.kill();
  });

  const pinned = () => ({ address: factory, codeHash: factoryHash });

  describe("trusted-circle route", () => {
    it("accepts two legitimate circles whose runtime code hashes differ", async () => {
      const ha = keccak256((await pub.getCode({ address: circleA }))!);
      const hb = keccak256((await pub.getCode({ address: circleB }))!);
      assert.notEqual(ha, hb, "immutables make each circle's bytecode differ");
      assert.deepEqual(await checkTrusted(pub, circleA, pinned()), { ok: true });
      assert.deepEqual(await checkTrusted(pub, circleB, pinned()), { ok: true });
    });

    it("refuses a circle from a foreign factory with the same bytecode", async () => {
      const other = await deploy(wallets[2]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
      const foreign = (await write(wallets[2]!, other, othelloFactoryAbi as Abi, "createCircle", [
        params(), [accounts[2]!.address, accounts[0]!.address, accounts[1]!.address],
      ])) as Address;
      assert.deepEqual(await checkTrusted(pub, foreign, pinned()), { ok: false, reason: "not-registered" });
    });

    it("refuses a lookalike that names the official factory but is not registered", async () => {
      const fake = await deploy(wallets[2]!, artifact("FakeCircle.sol", "FakeCircle"), [factory]);
      assert.deepEqual(await checkTrusted(pub, fake, pinned()), { ok: false, reason: "not-registered" });
    });

    it("refuses when the factory's code hash differs from the pinned one", async () => {
      const wrong = { address: factory, codeHash: keccak256("0x00") };
      assert.deepEqual(await checkTrusted(pub, circleA, wrong), { ok: false, reason: "factory-code" });
    });

    it("refuses an address with no code, and everything before deployment", async () => {
      assert.deepEqual(await checkTrusted(pub, accounts[2]!.address, pinned()), { ok: false, reason: "no-code" });
      assert.deepEqual(await checkTrusted(pub, circleA, null), { ok: false, reason: "not-deployed" });
    });

    it("an untrusted circle gets no approval and no write", async () => {
      const fake = await deploy(wallets[2]!, artifact("FakeCircle.sol", "FakeCircle"), [factory]);
      const nonce = await pub.getTransactionCount({ address: accounts[1]!.address });
      const ad = createRobinhoodAdapter({
        publicClient: pub, walletClient: wallets[1]!, account: accounts[1]!.address, circle: fake, factory: pinned(), usdg,
      });
      const r = await ad.joinAndLock({ amount: 20n * U });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, "NotTrusted");
      assert.equal(await pub.getTransactionCount({ address: accounts[1]!.address }), nonce, "nothing sent");
    });
  });

  describe("adapter split", () => {
    const evm = () =>
      createRobinhoodAdapter({
        publicClient: pub, walletClient: wallets[0]!, account: accounts[0]!.address, circle: circleA, factory: pinned(), usdg,
      });

    it("the common surface has no top-up", () => {
      const common = toCommon(evm());
      assert.equal("topUpReserve" in common, false);
      assert.equal(common.profile, "common-v1");
      assert.deepEqual(
        Object.keys(common).filter((k) => typeof (common as unknown as Record<string, unknown>)[k] === "function").sort(),
        ["readCircle", ...Object.keys(ACTION_ARGS["common-v1"]).filter((k) => k !== "quote")].sort(),
      );
    });

    it("the EVM top-up refuses {amount} alone, before any wallet call", async () => {
      const nonce = await pub.getTransactionCount({ address: accounts[0]!.address });
      assert.throws(() => evm().topUpReserve({ amount: 1n } as never), InvalidArguments);
      assert.equal(await pub.getTransactionCount({ address: accounts[0]!.address }), nonce);
    });

    it("a Solana top-up refuses {amount, expectedFill}, before any wallet call", () => {
      let prompts = 0;
      const solanaTopUp: SolanaAdapter["topUpReserve"] = checked("solana-pyth-v2", "topUpReserve", async () => {
        prompts++;
        return { ok: true as const, txHash: "x" };
      });
      assert.throws(() => solanaTopUp({ amount: 1n, expectedFill: 0n } as never), InvalidArguments);
      assert.equal(prompts, 0);
      return solanaTopUp({ amount: 1n }).then(() => assert.equal(prompts, 1));
    });

    it("reports topUpConsentBound: true on Robinhood", () => {
      assert.equal(evm().capabilities.topUpConsentBound, true);
    });
  });

  describe("end to end through the adapter", () => {
    it("runs circle A: exact approvals, refusals decoded, completes, everyone withdraws", async () => {
      const ads = accounts.map((a, i) =>
        createRobinhoodAdapter({
          publicClient: pub, walletClient: wallets[i]!, account: a.address, circle: circleA, factory: pinned(), usdg,
        }),
      );
      const start = await Promise.all(accounts.map((a) => pub.readContract({
        address: usdg, abi: artifact("MockUSDG.sol", "MockUSDG").abi, functionName: "balanceOf", args: [a.address],
      }) as Promise<bigint>));

      const tooSmall = await ads[0]!.joinAndLock({ amount: 1n * U });
      assert.equal(!tooSmall.ok && tooSmall.error, "CollateralBelowMinimum");
      assert.match(!tooSmall.ok ? tooSmall.message : "", /counts for 0\.8 USDG of cover/);

      for (const ad of ads) ok(await ad.joinAndLock({ amount: 20n * U }), "joinAndLock");
      assert.equal((await ads[1]!.activate({})).ok, false, "only the creator activates");
      ok(await ads[0]!.activate({}), "activate");

      for (let r = 0; r < 3; r++) {
        for (const ad of ads) ok(await ad.contribute({}), "contribute");
        if (r === 0) {
          const twice = await ads[0]!.contribute({});
          assert.equal(!twice.ok && twice.error, "AlreadyContributed");
          const v = await ads[2]!.readCircle("");
          const stale = await ads[2]!.topUpReserve({ amount: 1n * U, expectedFill: 1n * U });
          assert.equal(!stale.ok && stale.error, "TopUpFillChanged");
          assert.equal(topUpFill(v.escrowDeficit, 1n * U), 0n);
        }
        ok(await ads[r]!.releasePot({}), `releasePot round ${r}`);
      }
      const v = await readCircle(pub, circleA, usdg);
      assert.equal(v.status, "Completed");
      for (const ad of ads) ok(await ad.withdraw({}), "withdraw");
      for (let i = 0; i < 3; i++) {
        const bal = (await pub.readContract({
          address: usdg, abi: artifact("MockUSDG.sol", "MockUSDG").abi, functionName: "balanceOf", args: [accounts[i]!.address],
        })) as bigint;
        assert.equal(bal, start[i], "every member ends where they started");
        const allowance = (await pub.readContract({
          address: usdg, abi: artifact("MockUSDG.sol", "MockUSDG").abi, functionName: "allowance",
          args: [accounts[i]!.address, circleA],
        })) as bigint;
        assert.equal(allowance, 0n, "exact approvals leave nothing approved");
      }
      assert.equal(getAddress(v.factory), getAddress(factory));
      void othelloCircleAbi;
    });
  });
});
