/**
 * Adversary on cbdba79 (PR #25, circle reads one at a time). Spec 1: "No two list or portfolio circle reads overlap".
 *
 * readCircleInTurn (app/src/lib/robinhood/adapter-core.ts) starts the next circle read as soon as the previous read's
 * promise settles. But a read settles on its FIRST failed call: readCircleAt awaits Promise.all over about 33 calls, and
 * Promise.all rejects at the first rejection while the other calls are still pending. viem's http transport retries a
 * rate-limited call by itself (retryCount 3, backoff 150, 300, 600 ms; utils/buildRequest.js shouldRetry treats an
 * HTTP 429 and a batch item's JSON-RPC `code: 429` as retryable), so when one call of a batch fails outright and the
 * others are rate-limited, the read is "over" while its rate-limited calls keep going to the RPC for about a second,
 * now side by side with the next circle's read: exactly the burst the queue exists to prevent.
 *
 * Attack: two real circles on the real OthelloFactory. The RPC answers every batch item of circle 1's pinned read with
 * a per-item rate limit (`code: 429`, the form viem documents for Alchemy in batch mode), except its `factory()` call,
 * which gets "header not found" (-32000; the load-balanced RPC answer readCircle already steps back a block for, see
 * its comment citing the adversary pass on 9343ef9). Circle 2 is answered normally. Harness: local anvil (chain 46630),
 * a small HTTP proxy that records when each pinned eth_call arrives and for which circle, the real readCircleInTurn
 * through a viem http client with batch: true (as robinhoodPublicClient in app/src/lib/robinhood/wallet.ts).
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-read-in-turn-straggler-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, http, toFunctionSelector,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { readCircleInTurn } from "../app/src/lib/robinhood/adapter-core.ts";
import { USDG } from "../app/src/lib/robinhood/chain.ts";

const PORT = 8841;
const PROXY_PORT = 8842;
const ANVIL = `http://127.0.0.1:${PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const U = 1_000_000n;
const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex; runtime: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, runtime: j.deployedBytecode.object };
}
const FACTORY_GETTER = toFunctionSelector("factory()");

type Rpc = { jsonrpc: "2.0"; id: number; method: string; params?: [{ to?: string; data?: string }, unknown] };

describe("Adversary on cbdba79: a failed circle read's retried calls overlap the next circle's read", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let proxy: Server;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];
  let made: Address[] = [];
  // every pinned eth_call (a full circle read) the RPC received: when, and for which circle (lower case)
  const seen: { at: number; to: string }[] = [];

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...(request as object), chain } as never) });
    return result as unknown;
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(ANVIL) }));

    await pub.request({ method: "anvil_setCode", params: [USDG, artifact("MockUSDG.sol", "MockUSDG").runtime] } as never);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [USDG]);
    made = [];
    for (let k = 0; k < 2; k++) {
      made.push((await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
        { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
          roundSecs: 60n, graceSecs: 30n },
        accounts.map((a) => a.address),
      ])) as Address);
    }
    const refused = made[0]!.toLowerCase();

    proxy = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const parsed = JSON.parse(body) as Rpc | Rpc[];
        const calls = [parsed].flat();
        // a full circle read pins its calls to a block hash; anything else (getBlock) passes
        const pinned = (c: Rpc) => c.method === "eth_call" && typeof c.params?.[1] === "object" && c.params?.[1] !== null;
        const now = performance.now();
        for (const c of calls) if (pinned(c)) seen.push({ at: now, to: String(c.params?.[0]?.to ?? "").toLowerCase() });
        const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body });
        const real = (await r.json()) as unknown;
        const answers = [real].flat() as { id: number }[];
        // circle 1's calls: its factory() read meets a node without the block, the rest are rate-limited per item
        const out = answers.map((a) => {
          const c = calls.find((x) => x.id === a.id)!;
          if (!pinned(c) || String(c.params?.[0]?.to ?? "").toLowerCase() !== refused) return a;
          return c.params?.[0]?.data?.startsWith(FACTORY_GETTER)
            ? { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "header not found" } }
            : { jsonrpc: "2.0", id: c.id, error: { code: 429, message: "Too Many Requests" } };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
      });
    });
    await new Promise<void>((ok) => proxy.listen(PROXY_PORT, "127.0.0.1", ok));
  });
  after(() => {
    anvil?.kill();
    proxy?.close();
  });

  it("sends no call for circle 1 once circle 2's read has started", async () => {
    // the app's client: the public RPC (here the proxy) with batch: true
    const client = createPublicClient({ chain: { ...chain, rpcUrls: { default: { http: [PROXY] } } }, transport: http(undefined, { batch: true }) });
    const first = readCircleInTurn(client, made[0]!, () => false, USDG).then(() => "read", () => "failed");
    const second = readCircleInTurn(client, made[1]!, () => false, USDG).then(() => "read", (e: unknown) => `failed: ${String(e)}`);
    assert.equal(await first, "failed", "precondition: circle 1's read fails");
    assert.equal(await second, "read", "precondition: circle 2 reads in full");
    await sleep(2_000); // anything still retrying for circle 1 reaches the RPC by now

    const c1 = made[0]!.toLowerCase();
    const c2 = made[1]!.toLowerCase();
    const c2Start = Math.min(...seen.filter((x) => x.to === c2).map((x) => x.at));
    const late = seen.filter((x) => x.to === c1 && x.at >= c2Start);
    assert.ok(Number.isFinite(c2Start), "precondition: circle 2's read reached the RPC");
    assert.equal(late.length, 0,
      `${late.length} calls for circle 1 reached the RPC after circle 2's read had started (the last ` +
      `${Math.round(Math.max(...late.map((x) => x.at)) - c2Start)} ms after it): the two circle reads overlapped`);
  });
});
