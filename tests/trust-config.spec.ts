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

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  USDG, changedSince, checkConfigValue, configFromSource, expectedCreationInput, expectedRuntime, importBoundary, loadConfig, verify,
  type Inputs,
} from "../ops/trust-config.ts";

const PORT = 8593;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 46630, name: "local", nativeCurrency: { name: "E", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 0 });
const art = (f: string, n: string) => JSON.parse(readFileSync(new URL(`../evm/out/${f}/${n}.json`, import.meta.url), "utf8"));

const cfg = (address: string, codeHash: string) => checkConfigValue({ address, codeHash });

describe("trust-config (ops/trust-config.ts)", function () {
  this.timeout(60_000);
  let anvil: ChildProcess;
  let factory: Address;
  let deployTx: Hex;
  let deployTxOther: Hex;
  let pub: ReturnType<typeof createPublicClient>;
  let other: Address;
  let code: Hex;
  let otherCode: Hex;
  const artifact = art("OthelloFactory.sol", "OthelloFactory");

  const receipt = (address: Address, args: string[] = [USDG], chainId = 46630) => ({
    chain: chainId,
    commit: "abc1234",
    transactions: [{ hash: address === factory ? deployTx : deployTxOther, transactionType: "CREATE", contractName: "OthelloFactory", contractAddress: address, arguments: args }],
    receipts: [{ contractAddress: address, status: "0x1" }],
  });
  let deployInput: Hex;
  const good = (): Inputs => ({
    config: cfg(factory, keccak256(code)),
    receipt: receipt(factory),
    artifact,
    chainCode: code,
    chainId: 46630,
    changedSinceReceipt: [],
    chainDeployTx: { input: deployInput, to: null },
    chainDeployReceipt: { status: "0x1", contractAddress: factory },
    trustSources: [],
  });

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC) });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    const w = createWalletClient({ account, chain, transport: http(RPC) });
    const mock = art("MockUSDG.sol", "MockUSDG");
    await pub.request({ method: "anvil_setCode" as never, params: [USDG, mock.deployedBytecode.object] as never });
    const deploy = async (token: Address) => {
      const h = await w.deployContract({ abi: artifact.abi as Abi, bytecode: artifact.bytecode.object as Hex, args: [token] });
      return { hash: h, address: (await pub.waitForTransactionReceipt({ hash: h })).contractAddress! };
    };
    const d1 = await deploy(USDG);
    factory = d1.address;
    deployTx = d1.hash;
    deployInput = (await pub.getTransaction({ hash: deployTx })).input;
    const h2 = await w.deployContract({ abi: mock.abi as Abi, bytecode: mock.bytecode.object as Hex });
    const otherToken = (await pub.waitForTransactionReceipt({ hash: h2 })).contractAddress!;
    const d2 = await deploy(otherToken);
    other = d2.address;
    deployTxOther = d2.hash;
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

  it("passes while TRUSTED_FACTORY is null (page read-only), and the committed config is null", async () => {
    assert.deepEqual(verify({ ...good(), config: checkConfigValue(null) }), []);
    assert.equal((await loadConfig()).state, "null");
  });

  it("fails on a config it cannot read", () => {
    for (const v of [undefined, "0x", [], { address: factory }, { address: factory, codeHash: keccak256(code), extra: 1 },
      { address: "not an address", codeHash: keccak256(code) }, { address: factory, codeHash: "0x1234" }]) {
      assert.match(verify({ ...good(), config: checkConfigValue(v) }).join(), /neither null nor/, JSON.stringify(v));
    }
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

  it("fails unless the deployed commit is an ancestor and only config, receipt and notes changed since", () => {
    assert.match(verify({ ...good(), changedSinceReceipt: null }).join(), /not an ancestor of HEAD/);
    for (const p of ["app/src/components/robinhood/trust.ts", "app/next.config.mjs", "app/tsconfig.json", "evm/src/OthelloCircle.sol", "app/package.json"]) {
      assert.match(verify({ ...good(), changedSinceReceipt: [p] }).join(), /files other than the config/, p);
    }
    assert.deepEqual(verify({ ...good(), changedSinceReceipt: [
      "app/src/lib/robinhood/config.ts", "evm/broadcast/DeployFactory.s.sol/46630/run-latest.json", "DONE.md"] }), []);
  });

  it("fails when the config hash is not the live code's hash", () => {
    const i = good();
    i.config = cfg(factory, keccak256("0x00"));
    const f = verify(i).join();
    assert.match(f, /live code hash .* differs/);
    assert.match(f, /reviewed source compiles to/);
  });

  it("fails when the live code is a factory built with another token (source check catches it)", () => {
    const i: Inputs = {
      ...good(),
      config: cfg(other, keccak256(otherCode)),
      receipt: receipt(other, [USDG]),
      chainCode: otherCode,
    };
    assert.match(verify(i).join(), /reviewed source compiles to/);
  });

  it("fails when there is no code at the address, or the RPC is another chain", () => {
    assert.match(verify({ ...good(), chainCode: "0x" }).join(), /no code at/);
    assert.match(verify({ ...good(), chainId: 1 }).join(), /RPC chain id is 1/);
  });

  it("provenance: HEAD changed nothing since itself; an unknown or malformed commit is not an ancestor", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.deepEqual(changedSince(head), []);
    assert.equal(changedSince("0000000000000000000000000000000000000000"), null);
    assert.equal(changedSince("HEAD; rm -rf /"), null);
    assert.equal(changedSince(undefined), null);
  });

  it("config.ts must have its fixed shape: null or Object.freeze of two string literals, nothing computed", () => {
    const head = 'import type { Address, Hex } from "viem";\nexport type TrustedFactory = { address: Address; codeHash: Hex };\n';
    const decl = (v: string) => `${head}export const TRUSTED_FACTORY: TrustedFactory | null = ${v};\n`;
    const h = keccak256(code);
    assert.deepEqual(configFromSource(decl("null")), { state: "null" });
    assert.equal(configFromSource(decl(`Object.freeze({ address: "${factory}", codeHash: "${h}" })`)).state, "set");
    for (const bad of [
      decl(`{ address: "${factory}", codeHash: "${h}" }`),
      decl(`typeof window === "undefined" ? null : Object.freeze({ address: "${factory}", codeHash: "${h}" })`),
      decl(`Object.freeze({ address: "${factory}", codeHash: \`${h}\` })`),
      decl(`Object.freeze({ address: "${factory}", codeHash: "${h}", extra: "1" })`),
      decl(`Object.freeze({ address: A, codeHash: "${h}" })`),
      decl("null") + "export const OTHER = 1;\n",
      decl("null") + decl("null").slice(head.length),
      `${head}export let TRUSTED_FACTORY: TrustedFactory | null = null;\n`,
      `${head}export const TRUSTED_FACTORY = null;\n`,
      `${head}const TRUSTED_FACTORY: TrustedFactory | null = null;\nexport { TRUSTED_FACTORY };\n`,
    ]) {
      assert.equal(configFromSource(bad).state, "unreadable", bad);
    }
  });

  it("the chain must confirm the deployment: exact reviewed init code with USDG, a creation, success, that address", async () => {
    assert.equal(deployInput.toLowerCase(), expectedCreationInput(artifact, USDG), "the real deployment input is the expected one");
    assert.match(verify({ ...good(), chainDeployTx: null }).join(), /no deployment transaction/);
    // same runtime, other init code (e.g. a constructor that pre-registers a circle): input differs
    assert.match(verify({ ...good(), chainDeployTx: { input: `${deployInput}00`, to: null } }).join(), /creation code is not the reviewed/);
    assert.match(verify({ ...good(), chainDeployTx: { input: deployInput, to: factory } }).join(), /not a contract creation/);
    assert.match(verify({ ...good(), chainDeployReceipt: { status: "0x0", contractAddress: factory } }).join(), /no successful deployment receipt/);
    assert.match(verify({ ...good(), chainDeployReceipt: { status: "0x1", contractAddress: other } }).join(), /created .* not/);
    const otherInput = (await pub.getTransaction({ hash: deployTxOther })).input;
    assert.match(verify({ ...good(), chainDeployTx: { input: otherInput, to: null } }).join(), /creation code is not the reviewed/);
  });

  it("import boundary: only lib/robinhood/adapter.ts may import the config or the injectable core", () => {
    assert.deepEqual(importBoundary(), [], "the real app passes");
    const dir = mkdtempSync(join(tmpdir(), "trust-src-"));
    mkdirSync(join(dir, "lib/robinhood"), { recursive: true });
    mkdirSync(join(dir, "components"), { recursive: true });
    writeFileSync(join(dir, "lib/robinhood/config.ts"), "export const TRUSTED_FACTORY = null;");
    writeFileSync(join(dir, "lib/robinhood/adapter.ts"), 'import { TRUSTED_FACTORY } from "./config";\nimport * as c from "./adapter-core";');
    writeFileSync(join(dir, "lib/robinhood/adapter-core.ts"), 'import type { TrustedFactory } from "./config";');
    const cases: Record<string, string> = {
      "A.tsx": 'import { checkTrustedAgainst as ok } from "@/lib/robinhood/adapter-core";',
      "B.ts": 'export { TRUSTED_FACTORY } from "../lib/robinhood/config";',
      "C.js": 'const c = require("@/lib/robinhood/config.ts");',
      "D.tsx": 'const m = await import("@/lib/robinhood/adapter-core");',
      "E.ts": 'const p = "@/lib/robinhood/" + "config"; const m = await import(p);',
      "F.mjs": 'import * as x from "../lib/robinhood/adapter-core/index";',
    };
    for (const [n, src] of Object.entries(cases)) writeFileSync(join(dir, "components", n), src);
    writeFileSync(join(dir, "components/G.ts"), 'import type { TrustedFactory } from "@/lib/robinhood/config";');
    const f = importBoundary(dir).join("\n");
    for (const n of Object.keys(cases)) assert.ok(f.includes(`components/${n}`), `${n} not flagged:\n${f}`);
    assert.ok(!f.includes("components/G.ts"), "type-only imports carry no value and are allowed");
    assert.ok(!f.split("\n").some((l) => l.startsWith("lib/robinhood/")), `adapter.ts may import; core's type import is allowed:\n${f}`);
    assert.match(verify({ ...good(), trustSources: ["x"] }).join(), /x/, "a boundary failure fails the gate");
  });

  it("the CLI passes on the committed (null) config", () => {
    const out = execFileSync("npx", ["tsx", "ops/trust-config.ts", "--rpc", RPC], { encoding: "utf8" });
    assert.match(out, /TRUSTED_FACTORY is null, config.ts has its fixed shape, and only adapter.ts imports it/);
  });
});
