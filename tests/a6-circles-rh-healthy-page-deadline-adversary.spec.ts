/**
 * Adversary on 22bc733 (PR #25). Spec 2: "A read or page that would succeed within viem's own timeouts still succeeds
 * with the same result; the deadline never cuts off a healthy read."
 *
 * The 45 s deadline is per allSettledOrThrow call, sized for ONE call's worst case under viem (four tries of 10 s plus
 * 1.05 s of backoff). But listCirclesPageWith (app/src/lib/robinhood/adapter-core.ts) wraps its summaries in an outer
 * allSettledOrThrow, and each summarize runs TWO rounds one after the other (n/c/status/round/creator, then members),
 * each its own allSettledOrThrow. The outer 45 s therefore covers two sequential viem calls, up to about 82 s of
 * healthy work, and cuts off a page whose every call succeeds within viem's timeout and retries.
 *
 * Attack: a slow, rate-limited RPC that is still healthy by viem's rules. A local JSON-RPC relay in front of anvil
 * answers every request carrying a circle's listing read after 8.5 s (under viem's 10 s timeout), and the first two
 * times it sees each listing call it answers that call with the per-item rate limit `code: 429` (retryable by viem's
 * shouldRetry; the form tests/robinhood-read-in-turn-straggler-adversary.spec.ts already uses). Each call then succeeds
 * on viem's third try: about 3 x 8.5 s + 0.45 s = 26 s per round, two rounds about 52 s. The factory's own calls are
 * answered at once. Expected: the same page as a direct read; found: "Robinhood Chain did not finish answering."
 *
 * Harness: local anvil (chain 46630), real MockUSDG, real OthelloFactory with its real code hash, one circle made by
 * createCircle; listCirclesPageWith through a viem http client with batch: true and viem's defaults (as
 * robinhoodPublicClient in lib/robinhood/wallet.ts).
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-rh-healthy-page-deadline-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { robinhoodHttp } from "../app/src/lib/robinhood/transport.ts";
import { mnemonicToAccount } from "viem/accounts";

import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { listCirclesPageWith } from "../app/src/lib/robinhood/adapter-core.ts";
import type { TrustedFactory } from "../app/src/lib/robinhood/config.ts";

const PORT = 8975;
const RELAY_PORT = 8976;
const ANVIL = `http://127.0.0.1:${PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const U = 1_000_000n;
const SLOW_MS = 8_500;
const BUSY_TIMES = 2;
const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

type RpcItem = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
type RpcReply = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

describe("Adversary on 22bc733: the listing's outer deadline cuts off a page whose every call succeeds within viem's rules", function () {
  this.timeout(280_000);
  let anvil: ChildProcess;
  let relay: Server | undefined;
  let pub: PublicClient;
  let w0: WalletClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let factory: TrustedFactory;
  let circle: Address;
  // every request the relay answered for a circle's listing call: how long it took, the longest is under viem's 10 s
  const answeredIn: number[] = [];

  async function deploy(a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w0.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w0.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    w0 = createWalletClient({ account: accounts[0]!, chain, transport: http(ANVIL) });
    const usdg = await deploy(artifact("MockUSDG.sol", "MockUSDG"));
    const fAddr = await deploy(artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    factory = { address: fAddr, codeHash: keccak256((await pub.getCode({ address: fAddr }))!) } as TrustedFactory;
    const { request, result } = await pub.simulateContract({
      address: fAddr, abi: othelloFactoryAbi as Abi, functionName: "createCircle", account: w0.account!,
      args: [
        { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
          roundSecs: 60n, graceSecs: 30n },
        accounts.map((a) => a.address),
      ],
    } as never);
    await pub.waitForTransactionReceipt({ hash: await w0.writeContract({ ...(request as object), chain } as never) });
    circle = getAddress(result as Address);

    const lower = circle.toLowerCase();
    const callKey = (x: RpcItem) => {
      if (x.method !== "eth_call") return null;
      const tx = (x.params?.[0] ?? {}) as { to?: string; data?: string; input?: string };
      return tx.to?.toLowerCase() === lower ? (tx.data ?? tx.input ?? "").toLowerCase() : null;
    };
    const seen = new Map<string, number>();
    relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", async () => {
        const at = Date.now();
        const parsed = JSON.parse(body) as RpcItem | RpcItem[];
        const items = [parsed].flat();
        const slow = items.some((x) => callKey(x) !== null);
        const up = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body });
        const answered = (await up.json()) as RpcReply | RpcReply[];
        const out = [answered].flat().map((r) => {
          const key = callKey(items.find((i) => i.id === r.id)!);
          if (key === null) return r;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          return n <= BUSY_TIMES ? { jsonrpc: "2.0", id: r.id, error: { code: 429, message: "Too Many Requests" } } : r;
        });
        if (slow) await sleep(SLOW_MS - (Date.now() - at));
        if (slow) answeredIn.push(Date.now() - at);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(answered) ? out : out[0]));
      });
    });
    await new Promise<void>((r) => relay!.listen(RELAY_PORT, "127.0.0.1", () => r()));
  });
  after(() => {
    anvil?.kill();
    relay?.closeAllConnections();
    relay?.close();
  });

  it("lists the same page as a direct read when every call answers within viem's timeout and retries", async () => {
    const A = getAddress(accounts[0]!.address);
    const direct = await listCirclesPageWith(pub, factory, A);
    assert.deepEqual(direct.circles.map((c) => getAddress(c.address)), [circle], "precondition: the direct read lists the circle");

    const client = createPublicClient({ chain: { ...chain, rpcUrls: { default: { http: [RELAY] } } }, transport: robinhoodHttp() /* the app's own transport (lib/robinhood/transport.ts), as lib/robinhood/wallet.ts builds it */ });
    const started = Date.now();
    const got = await listCirclesPageWith(client, factory, A).then(
      (p) => p,
      (e: unknown) => `failed after ${Math.round((Date.now() - started) / 1000)} s: ${(e as Error).message}`,
    );
    assert.ok(answeredIn.length > 0 && Math.max(...answeredIn) < 10_000,
      `precondition: every slow request was answered under viem's 10 s timeout (longest ${Math.max(...answeredIn)} ms)`);
    assert.deepEqual(got, direct, "a page whose every call succeeds within viem's timeout and retries lists the same page");
  });
});
