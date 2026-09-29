/**
 * Adversarial cases for creating and listing Robinhood circles (A1, 44e9538..b1eb00e; list cases rewritten for
 * ARB r10's per-wallet index after Codex code review r3 M2), against the REAL
 * contracts on a local anvil chain that uses Robinhood testnet's chain id (46630). Needs `forge build` in evm/.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 180000 tests/robinhood-create-list-adversary.spec.ts
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

import { createCircleWith, listCirclesPageWith } from "../app/src/lib/robinhood/adapter-core.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";

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

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

const U = 1_000_000n;
const params = (over: Partial<Record<string, bigint>> = {}) => ({
  n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n,
  roundSecs: 60n, graceSecs: 30n, ...over,
});

describe("Robinhood create and list, adversarial (anvil, chain 46630)", function () {
  this.timeout(180_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let factory: Address;
  let factoryHash: Hex;
  let usdg: Address;
  const usdgAbi = artifact("MockUSDG.sol", "MockUSDG").abi;

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
    const { request } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...(request as object), chain } as never) });
  }

  async function create(w: WalletClient, members: readonly Address[]): Promise<Address> {
    const { request, result } = await pub.simulateContract({
      address: factory, abi: othelloFactoryAbi, functionName: "createCircle", args: [params(), members], account: w.account!,
    } as never);
    const hash = await w.writeContract({ ...(request as object), chain } as never);
    await pub.waitForTransactionReceipt({ hash });
    return result as unknown as Address;
  }

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
    usdg = await deploy(wallets[0]!, artifact("MockUSDG.sol", "MockUSDG"));
    factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    factoryHash = keccak256((await pub.getCode({ address: factory }))!);
  });

  after(() => {
    anvil?.kill();
  });

  const pinned = () => ({ address: factory, codeHash: factoryHash });
  const count = async () => (await pub.readContract({ address: factory, abi: othelloFactoryAbi, functionName: "circleCount" })) as bigint;

  it("a wallet speed-up (same createCircle, higher fee) that creates the circle is reported as that circle", async () => {
    const me = accounts[0]!;
    const members = accounts.map((a) => a.address);
    const before = await count();
    await pub.request({ method: "evm_setAutomine" as never, params: [false] as never });
    try {
      // The wallet the page hands to createCircleWith. It signs what it is asked to sign; then, as MetaMask's
      // "Speed up" does, it re-sends the very same transaction (same nonce, same to, same data) at a higher fee.
      const real = wallets[0]!;
      const speedUp = async (hash: Hex) => {
        await sleep(1_500); // the page is now waiting for the receipt and has seen the pending transaction
        const tx = await pub.getTransaction({ hash });
        await real.sendTransaction({
          account: me, chain, to: tx.to!, data: tx.input, value: tx.value, nonce: tx.nonce, gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas! * 3n, maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 1n) * 3n + 1_000_000_000n,
        });
        await pub.request({ method: "evm_mine" as never, params: [] as never });
      };
      const wallet = {
        chain,
        account: real.account,
        getChainId: () => real.getChainId(),
        writeContract: async (req: never) => {
          const hash = await real.writeContract(req);
          void speedUp(hash);
          return hash;
        },
      } as unknown as WalletClient;

      const r = await createCircleWith({ publicClient: pub, walletClient: wallet, account: me.address, factory: pinned() }, params() as never, members);

      // What actually happened on chain: exactly one new circle, created by this wallet, from this factory.
      assert.equal(await count(), before + 1n, "the sped-up createCircle was mined and created one circle");
      const created = (await pub.readContract({ address: factory, abi: othelloFactoryAbi, functionName: "circles", args: [before] })) as Address;
      assert.equal(
        ((await pub.readContract({ address: created, abi: othelloCircleAbi, functionName: "creator" })) as Address).toLowerCase(),
        me.address.toLowerCase(),
      );
      // The page must not tell the creator no circle exists (they would create a second one for the same members).
      assert.equal(r.ok, true, r.ok ? "" : `adapter said ${r.error}: "${r.message}" but circle ${created} was created`);
      if (r.ok) assert.equal(r.circle.toLowerCase(), created.toLowerCase());
    } finally {
      await pub.request({ method: "evm_setAutomine" as never, params: [true] as never });
    }
  });

  it("My circles finds a wallet's circle after 100 strangers' circles, half of them naming it, with bounded reads", async () => {
    // Codex r3 M2 (and the adversary's 40-circle case before it): anyone may create circles with members of their
    // choosing. Under ARB r10 a wallet's list grows only by its own create or join, so neither unrelated circles nor
    // circles that merely name the victim can bury the one it joined, and the page's reads do not grow with them.
    const victimAcct = mnemonicToAccount(MNEMONIC, { addressIndex: 5 });
    const victim = victimAcct.address;
    const victimWallet = createWalletClient({ account: victimAcct, chain, transport: http(RPC) });
    const mine = await create(wallets[0]!, [accounts[0]!.address, accounts[1]!.address, victim]);
    await write(wallets[0]!, usdg, usdgAbi, "mint", [victim, 100n * U]);
    await write(victimWallet, usdg, usdgAbi, "approve", [mine, 20n * U]);
    await write(victimWallet, mine, othelloCircleAbi as Abi, "joinAndLock", [15n * U]);
    for (let i = 0; i < 100; i++) {
      const members = i % 2 === 0
        ? [accounts[2]!.address, accounts[0]!.address, accounts[1]!.address]
        : [accounts[2]!.address, victim, accounts[1]!.address];
      await create(wallets[2]!, members);
    }
    let reads = 0;
    const counting = new Proxy(pub, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "readContract" || k === "getCode") return (...a: unknown[]) => { reads++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
        return v;
      },
    }) as PublicClient;
    const page = await listCirclesPageWith(counting, pinned(), victim);
    assert.deepEqual(page.circles.map((c) => c.address.toLowerCase()), [mine.toLowerCase()], "exactly the circle the victim joined");
    assert.equal(page.before, null);
    // trust check (code + factory reads), count, page, and one circle's 5 fields + 3 members: far below 100 circles
    assert.ok(reads <= 16, `reads for one listed circle: ${reads}`);
  });

  it("\"Show more\" pages a long list newest first, without repeats or gaps when a circle is added between pages", async () => {
    const who = accounts[2]!.address; // created 100+ circles above
    const total0 = Number(await pub.readContract({ address: factory, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [who] }));
    assert.ok(total0 > 20);
    const seen: string[] = [];
    let before: number | undefined;
    let first = true;
    let added: Address | null = null;
    for (;;) {
      const page = await listCirclesPageWith(pub, pinned(), who, before);
      assert.ok(page.circles.length <= 10, "at most 10 per page");
      seen.push(...page.circles.map((c) => c.address.toLowerCase()));
      if (first) {
        first = false;
        added = await create(wallets[2]!, [accounts[2]!.address, accounts[0]!.address, accounts[1]!.address]); // lands between pages
      }
      if (page.before === null) break;
      before = page.before;
    }
    const expected: string[] = [];
    const all = (await pub.readContract({ address: factory, abi: othelloFactoryAbi, functionName: "circlesOfPage", args: [who, 0n, 50n] })) as Address[];
    for (let start = 50; start < total0; start += 50) {
      all.push(...((await pub.readContract({
        address: factory, abi: othelloFactoryAbi, functionName: "circlesOfPage", args: [who, BigInt(start), 50n] })) as Address[]));
    }
    for (const a of all.slice(0, total0).reverse()) expected.push(a.toLowerCase());
    assert.deepEqual(seen, expected, "the first total0 entries, newest first, each once");
    assert.ok(added && !seen.includes(added.toLowerCase()), "a circle added after the first page appears on the next refresh, not mid-list");
  });
});
