/**
 * CI job `trust-config` (ops/trust-config.ts), ARB-DESIGN r9 sections 7.1 and 9.1: one passing case and one
 * failing case per check, against a REAL OthelloFactory deployed on anvil with Robinhood testnet's chain id.
 * Needs `forge build` in evm/ first.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { createPublicClient, createWalletClient, defineChain, http, keccak256, type Abi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { PATHS, USDG, expectedRuntime, parseConfig, sourceUnchanged, verify, type Inputs } from "../ops/trust-config.ts";

const PORT = 8593;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 46630, name: "local", nativeCurrency: { name: "E", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 0 });
const art = (f: string, n: string) => JSON.parse(readFileSync(new URL(`../evm/out/${f}/${n}.json`, import.meta.url), "utf8"));

const configSrc = (addr: string, hash: string) =>
  `export const TRUSTED_FACTORY: TrustedFactory | null = { address: "${addr}", codeHash: "${hash}" };`;

describe("trust-config (ops/trust-config.ts)", function () {
  this.timeout(60_000);
  let anvil: ChildProcess;
  let factory: Address;
  let other: Address;
  let code: Hex;
  let otherCode: Hex;
  const artifact = art("OthelloFactory.sol", "OthelloFactory");

  const receipt = (address: Address, args: string[] = [USDG], chainId = 46630) => ({
    chain: chainId,
    commit: "abc1234",
    transactions: [{ transactionType: "CREATE", contractName: "OthelloFactory", contractAddress: address, arguments: args }],
    receipts: [{ contractAddress: address, status: "0x1" }],
  });
  const good = (): Inputs => ({
    config: parseConfig(configSrc(factory, keccak256(code))),
    receipt: receipt(factory),
    artifact,
    chainCode: code,
    chainId: 46630,
    sourceUnchangedSinceReceipt: true,
  });

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    const pub = createPublicClient({ chain, transport: http(RPC) });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    const w = createWalletClient({ account, chain, transport: http(RPC) });
    const mock = art("MockUSDG.sol", "MockUSDG");
    await pub.request({ method: "anvil_setCode" as never, params: [USDG, mock.deployedBytecode.object] as never });
    const deploy = async (token: Address) => {
      const h = await w.deployContract({ abi: artifact.abi as Abi, bytecode: artifact.bytecode.object as Hex, args: [token] });
      return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
    };
    factory = await deploy(USDG);
    const h2 = await w.deployContract({ abi: mock.abi as Abi, bytecode: mock.bytecode.object as Hex });
    const otherToken = (await pub.waitForTransactionReceipt({ hash: h2 })).contractAddress!;
    other = await deploy(otherToken);
    code = (await pub.getCode({ address: factory }))!;
    otherCode = (await pub.getCode({ address: other }))!;
  });

  after(() => anvil?.kill());

  it("the reviewed source, with USDG filled in, is exactly the live factory's code", () => {
    assert.equal(expectedRuntime(artifact, USDG), code);
  });

  it("passes when every check holds", () => {
    assert.deepEqual(verify(good()), []);
  });

  it("passes while TRUSTED_FACTORY is null (page read-only), and the committed config is null", () => {
    assert.deepEqual(verify({ ...good(), config: parseConfig("export const TRUSTED_FACTORY: TrustedFactory | null = null;") }), []);
    assert.equal(parseConfig(readFileSync(PATHS.config, "utf8")).state, "null");
  });

  it("fails on a config it cannot read", () => {
    const f = verify({ ...good(), config: parseConfig('export const TRUSTED_FACTORY = JSON.parse(x);') });
    assert.match(f.join(), /neither null nor/);
  });

  it("fails when the receipt is missing", () => {
    assert.match(verify({ ...good(), receipt: null }).join(), /receipt is missing/);
  });

  it("fails when the config address is not the receipt's deployment", () => {
    const i = good();
    i.receipt = receipt(other);
    assert.match(verify(i).join(), /receipt deployed .* config says/);
  });

  it("fails when the receipt is for another chain", () => {
    assert.match(verify({ ...good(), receipt: receipt(factory, [USDG], 1) }).join(), /receipt chain is 1/);
  });

  it("fails when the constructor argument is not USDG", () => {
    assert.match(verify({ ...good(), receipt: receipt(factory, [other]) }).join(), /constructor argument/);
  });

  it("fails when the source changed since the receipt's commit", () => {
    assert.match(verify({ ...good(), sourceUnchangedSinceReceipt: false }).join(), /not an ancestor of HEAD/);
  });

  it("fails when the config hash is not the live code's hash", () => {
    const i = good();
    i.config = parseConfig(configSrc(factory, keccak256("0x00")));
    const f = verify(i).join();
    assert.match(f, /live code hash .* differs/);
    assert.match(f, /reviewed source compiles to/);
  });

  it("fails when the live code is a factory built with another token (source check catches it)", () => {
    const i: Inputs = {
      ...good(),
      config: parseConfig(configSrc(other, keccak256(otherCode))),
      receipt: receipt(other, [USDG]),
      chainCode: otherCode,
    };
    assert.match(verify(i).join(), /reviewed source compiles to/);
  });

  it("fails when there is no code at the address, or the RPC is another chain", () => {
    assert.match(verify({ ...good(), chainCode: "0x" }).join(), /no code at/);
    assert.match(verify({ ...good(), chainId: 1 }).join(), /RPC chain id is 1/);
  });

  it("provenance: HEAD counts as unchanged; an unknown or malformed commit does not", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(sourceUnchanged(head), true);
    assert.equal(sourceUnchanged("0000000000000000000000000000000000000000"), false);
    assert.equal(sourceUnchanged("HEAD; rm -rf /"), false);
    assert.equal(sourceUnchanged(undefined), false);
  });

  it("the CLI passes on the committed (null) config", () => {
    const out = execFileSync("npx", ["tsx", "ops/trust-config.ts", "--rpc", RPC], { encoding: "utf8" });
    assert.match(out, /TRUSTED_FACTORY is null/);
  });
});
