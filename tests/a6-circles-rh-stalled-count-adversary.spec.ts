/**
 * Adversary on 22bc733 (PR #25). Spec 1: "No circle read or listing page waits forever: each fails within a bounded
 * time with a fixed sentence (no RPC URL or request body), and Try again then works."
 *
 * 22bc733 bounds allSettledOrThrow with a 45 s deadline because viem's http transport bounds only the wait for a
 * response's HEADERS, not its body. listCirclesPageWith (app/src/lib/robinhood/adapter-core.ts) awaits three calls
 * before its only allSettledOrThrow: checkTrustedFactory's getCode, then circlesOfCount, then circlesOfPage, each with
 * no deadline. An RPC that answers the circlesOfCount request's headers and then stalls its body leaves the listing
 * page pending forever: the list keeps "Looking for your circles" and never draws its error or Try again.
 *
 * Harness: local anvil (chain 46630), real MockUSDG, real OthelloFactory with its real runtime code hash, one circle
 * made by createCircle. A local JSON-RPC relay in front of anvil gives every request carrying the factory's
 * circlesOfCount call its status line and headers and no body while `stalling` is on. The page is read with
 * listCirclesPageWith through a viem http client with batch: true and viem's defaults (as robinhoodPublicClient in
 * lib/robinhood/wallet.ts). The test allows 120 s for the page to settle, then turns the stall off and expects Try
 * again to list the circle.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a6-circles-rh-stalled-count-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { robinhoodHttp } from "../app/src/lib/robinhood/transport.ts";
import { mnemonicToAccount } from "viem/accounts";

import { othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { listCirclesPageWith } from "../app/src/lib/robinhood/adapter-core.ts";
import type { TrustedFactory } from "../app/src/lib/robinhood/config.ts";

const PORT = 8973;
const RELAY_PORT = 8974;
const ANVIL = `http://127.0.0.1:${PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const U = 1_000_000n;
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

describe("Adversary on 22bc733: a listing page whose circlesOfCount body never arrives waits forever", function () {
  this.timeout(280_000);
  let anvil: ChildProcess;
  let relay: Server | undefined;
  let pub: PublicClient;
  let w0: WalletClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  let factory: TrustedFactory;
  let circle: Address;
  let stalling = true;
  let stalled = 0;

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

    const selCount = encodeFunctionData({
      abi: othelloFactoryAbi as Abi, functionName: "circlesOfCount", args: [accounts[0]!.address],
    }).slice(0, 10).toLowerCase();
    const isCount = (x: RpcItem) => {
      if (x.method !== "eth_call") return false;
      const tx = (x.params?.[0] ?? {}) as { to?: string; data?: string; input?: string };
      return tx.to?.toLowerCase() === fAddr.toLowerCase() && (tx.data ?? tx.input ?? "").toLowerCase().startsWith(selCount);
    };
    relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", async () => {
        const items = [JSON.parse(body) as RpcItem | RpcItem[]].flat();
        if (stalling && items.some(isCount)) {
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

  it("settles the stalled page within a bounded time, and Try again then lists the circle", async () => {
    const client = createPublicClient({ chain: { ...chain, rpcUrls: { default: { http: [RELAY] } } }, transport: robinhoodHttp() /* the app's own transport (lib/robinhood/transport.ts), as lib/robinhood/wallet.ts builds it */ });
    const A = getAddress(accounts[0]!.address);
    let outcome: string | undefined;
    const started = Date.now();
    void listCirclesPageWith(client, factory, A).then(
      () => { outcome = "listed"; },
      (e: unknown) => { outcome = `failed: ${(e as Error).message}`; },
    );
    while (outcome === undefined && Date.now() - started < 120_000) await sleep(250);
    const waited = Math.round((Date.now() - started) / 1000);
    assert.ok(stalled >= 1, "precondition: the page asked circlesOfCount and the relay held that body");
    assert.ok(outcome !== undefined,
      `after ${waited} s the listing page has neither answered nor failed: its circlesOfCount call waits on a body ` +
      `that never arrives, outside the 45 s deadline`);

    stalling = false;
    let retried: string | undefined;
    const again = Date.now();
    void listCirclesPageWith(client, factory, A).then(
      (p) => { retried = p.circles.map((c) => getAddress(c.address)).join(","); },
      (e: unknown) => { retried = `failed: ${(e as Error).message}`; },
    );
    while (retried === undefined && Date.now() - again < 60_000) await sleep(250);
    assert.equal(retried, circle, "Try again lists the circle once the RPC answers");
  });
});
