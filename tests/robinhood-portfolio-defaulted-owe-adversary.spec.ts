/**
 * Adversary, Robinhood portfolio "Your circle" card (app/src/lib/robinhood/portfolio-circle.ts), pass on 08285a1.
 * Spec item 1: every figure on the card must match the contract, "You owe" being the contract's obligation for this
 * seat. SPEC.md:70: a defaulted member's coverage saturates at u32::MAX because the "member is defaulted (obligations
 * prepaid)", and the UI renders that as "Prepaid", never an amount. evm/src/OthelloCircle.sol agrees: declareDefault
 * moves the seat's whole obligation c x (n - roundsPaid) out of its collateral (and the reserve) into the escrow,
 * releasePot pays the seat's remaining rounds from that escrow, _recomputeCoverage skips a defaulted seat, and
 * contribute() refuses it (AlreadyDefaulted). So a seat settled in default owes nothing more and cannot pay.
 *
 * The circle is real: the contracts from evm/out on a local anvil chain with Robinhood testnet's chain id (46630),
 * read back with the app's own readCircle, then handed to circleCard as the page does.
 *   n=3, c=10, g=5, haircut 20%, coverage 130%, minStockCover 12, roundSecs 60, grace 30; every seat locks 20.
 *   round 1: all pay, seat 1 receives the pot.
 *   round 2: seats 2 and 3 pay; after deadline + grace seat 1 is marked, then declareDefault(0):
 *            o = 10 x (3 - 1) = 20, seized 20 (collateral 0), escrow 20.
 *
 *   cd evm && forge build && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-portfolio-defaulted-owe-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { readCircle } from "../app/src/lib/robinhood/adapter-core.ts";
import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { fmtUsdg } from "../app/src/lib/robinhood/copy.ts";
import { circleCard } from "../app/src/lib/robinhood/portfolio-circle.ts";

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
const U32_MAX = 4_294_967_295;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

describe("Robinhood portfolio adversary: the card's \"You owe\" for a seat settled in default (anvil, chain 46630)", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let usdg: Address;
  let circle: Address;

  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    const hash = await w.writeContract({ ...(request as object), chain } as never);
    await pub.waitForTransactionReceipt({ hash });
    return result as unknown;
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(RPC) }));
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    const dh = await wallets[0]!.deployContract({ abi: mock.abi, bytecode: mock.bytecode, account: wallets[0]!.account!, chain });
    usdg = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress!;
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    const fac = artifact("OthelloFactory.sol", "OthelloFactory");
    const fh = await wallets[0]!.deployContract({ abi: fac.abi, bytecode: fac.bytecode, args: [usdg], account: wallets[0]!.account!, chain });
    const factory = (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress!;
    const params = { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n, roundSecs: 60n, graceSecs: 30n };
    circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [params, accounts.map((a) => a.address)])) as Address;
    const C = othelloCircleAbi as Abi;
    for (const w of wallets) {
      await write(w, usdg, erc20Abi as Abi, "approve", [circle, 1_000n * U]);
      await write(w, circle, C, "joinAndLock", [20n * U]);
    }
    await write(wallets[0]!, circle, C, "activate");
    for (const w of wallets) await write(w, circle, C, "contribute");
    await write(wallets[0]!, circle, C, "releasePot"); // round 1: seat 1 receives
    await write(wallets[1]!, circle, C, "contribute");
    await write(wallets[2]!, circle, C, "contribute");
    await pub.request({ method: "evm_increaseTime", params: [120] } as never);
    await pub.request({ method: "evm_mine", params: [] } as never);
    await write(wallets[1]!, circle, C, "markDelinquent", [1, 0]);
    await write(wallets[1]!, circle, C, "declareDefault", [0]);
  });

  after(() => { anvil?.kill(); });

  it("the contract: seat 1 is settled in default, its obligations prepaid (coverage u32::MAX) and it cannot pay", async () => {
    const s = (await pub.readContract({ address: circle, abi: othelloCircleAbi, functionName: "seat", args: [0n] } as never)) as { lastCoverageBps: number; roundsPaid: number; collateral: bigint };
    assert.equal(Number(s.lastCoverageBps), U32_MAX, "SPEC.md:70: u32::MAX when the member is defaulted (obligations prepaid)");
    assert.equal(Number(s.roundsPaid), 1);
    assert.equal(await pub.readContract({ address: circle, abi: othelloCircleAbi, functionName: "escrow" } as never), 20n * U, "the whole obligation 10 x (3 - 1) sits in escrow");
    await assert.rejects(
      pub.simulateContract({ address: circle, abi: othelloCircleAbi, functionName: "contribute", account: accounts[0]! } as never),
      /AlreadyDefaulted/,
      "contribute() refuses a defaulted seat",
    );
  });

  it("the card does not tell a seat settled in default that it owes an amount the contract will not take", async () => {
    const view = await readCircle(pub, circle, usdg);
    const card = circleCard(view, accounts[0]!.address)!;
    const round = card.facts.find((f) => f.label === "Round 2");
    assert.equal(round?.value, "settled in default", "precondition: the card shows the seat as settled in default");
    const owe = card.facts.find((f) => f.label === "You owe")!;
    assert.ok(
      owe.value === fmtUsdg(0n) || /prepaid/i.test(owe.value),
      `the contract holds this seat's obligation as prepaid (escrow 20 USDG, coverage u32::MAX, contribute() refused), yet the card says "You owe ${owe.value}"`,
    );
  });
});
