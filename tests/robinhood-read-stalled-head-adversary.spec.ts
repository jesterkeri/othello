/**
 * Adversary on 22bc733 (PR #25). Spec 1: "No circle read or listing page waits forever: each fails within a bounded
 * time with a fixed sentence (no RPC URL or request body), and Try again then works." Spec 4: circle reads never
 * overlap through the queue, and "a read whose page moved on still stops".
 *
 * 22bc733 bounds allSettledOrThrow with a 45 s deadline because viem's http transport bounds only the wait for a
 * response's HEADERS (withTimeout clears its timer once fetch resolves; the body is then read with no timeout). But
 * readCircle (app/src/lib/robinhood/adapter-core.ts) awaits `client.getBlock({ blockTag: "latest" })` before any
 * allSettledOrThrow, with no deadline of its own. An RPC that answers that request's headers and then stalls its body
 * leaves readCircle pending forever. readCircleInTurn chains every circle read of the tab on one module-level queue,
 * so the stuck read also holds every later circle read, including the Try again for this circle and the reads of a
 * page or wallet that has moved on (their `stale` check runs only when their turn comes, which never does).
 *
 * Harness: local anvil (chain 46630), real MockUSDG at the app's USDG address, real OthelloFactory, one circle made by
 * createCircle. A local JSON-RPC relay in front of anvil gives every request that carries eth_getBlockByNumber its
 * status line and headers and no body while `stalling` is on. The read goes through readCircleInTurn and a viem http
 * client with batch: true, viem's default timeout and retries (as robinhoodPublicClient in lib/robinhood/wallet.ts).
 * The test allows 150 s (three tries of 45 s plus readCircle's 0.4 s and 0.8 s waits) for the read to settle, then
 * turns the stall off and expects Try again to read the circle.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/robinhood-read-stalled-head-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, getAddress, http,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { robinhoodHttp } from "../app/src/lib/robinhood/transport.ts";
import { mnemonicToAccount } from "viem/accounts";

import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { readCircleInTurn } from "../app/src/lib/robinhood/adapter-core.ts";
import { USDG } from "../app/src/lib/robinhood/chain.ts";

const PORT = 8971;
const RELAY_PORT = 8972;
const ANVIL = `http://127.0.0.1:${PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
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

type RpcItem = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };

describe("Adversary on 22bc733: a circle read whose head block body never arrives waits forever", function () {
  this.timeout(280_000);
  let anvil: ChildProcess;
  let relay: Server | undefined;
  let pub: PublicClient;
  let w0: WalletClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let circle: Address;
  let stalling = true;
  let stalled = 0;

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    w0 = createWalletClient({ account: accounts[0]!, chain, transport: http(ANVIL) });
    await pub.request({ method: "anvil_setCode", params: [USDG, artifact("MockUSDG.sol", "MockUSDG").runtime] } as never);
    const f = artifact("OthelloFactory.sol", "OthelloFactory");
    const dh = await w0.deployContract({ abi: f.abi, bytecode: f.bytecode, args: [USDG], account: w0.account!, chain });
    const factory = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress!;
    const { request, result } = await pub.simulateContract({
      address: factory, abi: othelloFactoryAbi as Abi, functionName: "createCircle", account: w0.account!,
      args: [
        { n: 3n, c: 100n * U, g: 87n * U, minStockCover: 0n, haircutBps: 0n, coverageBps: 13000n, warnBps: 11000n,
          roundSecs: 60n, graceSecs: 30n },
        accounts.map((a) => a.address),
      ],
    } as never);
    await pub.waitForTransactionReceipt({ hash: await w0.writeContract({ ...(request as object), chain } as never) });
    circle = getAddress(result as Address);

    relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", async () => {
        const items = [JSON.parse(body) as RpcItem | RpcItem[]].flat();
        if (stalling && items.some((x) => x.method === "eth_getBlockByNumber")) {
          stalled++;
          res.writeHead(200, { "content-type": "application/json" });
          res.flushHeaders();
          return;
        }
        const up = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await up.text());
      });
    });
    await new Promise<void>((r) => relay!.listen(RELAY_PORT, "127.0.0.1", () => r()));
  });
  after(() => {
    anvil?.kill();
    relay?.closeAllConnections();
    relay?.close();
  });

  it("settles the stalled read within a bounded time, and Try again then reads the circle", async () => {
    const client = createPublicClient({ chain: { ...chain, rpcUrls: { default: { http: [RELAY] } } }, transport: robinhoodHttp() /* the app's own transport (lib/robinhood/transport.ts), as lib/robinhood/wallet.ts builds it */ });
    let outcome: string | undefined;
    const started = Date.now();
    void readCircleInTurn(client, circle, () => false, USDG).then(
      () => { outcome = "read"; },
      (e: unknown) => { outcome = `failed: ${(e as Error).message}`; },
    );
    while (outcome === undefined && Date.now() - started < 150_000) await sleep(250);
    const waited = Math.round((Date.now() - started) / 1000);
    assert.ok(stalled >= 1, "precondition: the read asked for the head block and the relay held that body");
    assert.ok(outcome !== undefined,
      `after ${waited} s the circle read has neither answered nor failed: readCircle's getBlock waits on a body that ` +
      `never arrives, outside the 45 s deadline, and it holds the circle read queue`);
    assert.ok(!outcome.includes("127.0.0.1"), `the failure names no RPC URL (got: ${outcome})`);

    // Try again, with the RPC answering normally
    stalling = false;
    let retried: string | undefined;
    const again = Date.now();
    void readCircleInTurn(client, circle, () => false, USDG).then(
      (v) => { retried = getAddress(v.address); },
      (e: unknown) => { retried = `failed: ${(e as Error).message}`; },
    );
    while (retried === undefined && Date.now() - again < 60_000) await sleep(250);
    assert.equal(retried, circle, "Try again reads the circle once the RPC answers");
  });
});
