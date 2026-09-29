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

import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createRobinhoodAdapter } from "../app/src/lib/robinhood/adapter.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  USDG, addressesIn, appTreeRules, artifactDigest, buildFilePins, bundleAddresses, changedSince, checkConfigValue, configFromSource, expectedCreationInput, expectedRuntime, importBoundary, loadConfig,
  moduleShadows, noEnvInTrustCode, scanTree, uploadSet, usdgMatches, verify,
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
      "app/src/lib/robinhood/config.ts", "evm/broadcast/DeployFactory.s.sol/46630/run-latest.json", "DONE.md",
      "release/robinhood-prebuilt.json"] }), []);
    assert.match(verify({ ...good(), changedSinceReceipt: ["release/other.json"] }).join(), /files other than the config/);
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

  it("what the bundler loads is what is checked: no JS modules and no same-stem files in app/src", () => {
    assert.deepEqual(moduleShadows(), [], "the real app passes");
    const shadows: [string, string][] = [["lib/robinhood/config.js", "export const TRUSTED_FACTORY = null;"],
                                         ["lib/robinhood/config.tsx", "export const TRUSTED_FACTORY = null;"],
                                         ["lib/robinhood/adapter.mjs", "export const x = 1;"],
                                         ["components/helper.cjs", "module.exports = {};"]];
    for (const [name, body] of shadows) {
      const dir = mkdtempSync(join(tmpdir(), "trust-shadow-"));
      cpSync(new URL("../app/src", import.meta.url), dir, { recursive: true });
      writeFileSync(join(dir, name), body);
      assert.notDeepEqual(moduleShadows(dir), [], name);
    }
  });

  it("next.config.mjs and tsconfig.json are pinned; a change or an extra next.config fails", () => {
    assert.deepEqual(buildFilePins(), [], "the committed build files match their pins");
    const root = mkdtempSync(join(tmpdir(), "trust-pins-"));
    mkdirSync(join(root, "app"));
    cpSync(new URL("../app/next.config.mjs", import.meta.url), join(root, "app/next.config.mjs"));
    cpSync(new URL("../app/tsconfig.json", import.meta.url), join(root, "app/tsconfig.json"));
    assert.deepEqual(buildFilePins(root), []);
    writeFileSync(join(root, "app/next.config.js"), "module.exports = {};");
    assert.match(buildFilePins(root).join(), /next\.config\.js exists/);
    writeFileSync(join(root, "app/tsconfig.json"), '{"compilerOptions":{"paths":{"@/*":["./evil/*"]}}}');
    assert.match(buildFilePins(root).join(), /tsconfig\.json changed/);
  });

  it("a mixed-case address with a bad checksum is unreadable; all-lowercase and valid checksums are read", () => {
    const h = keccak256(code);
    const lower = factory.toLowerCase();
    const bad = `0x${lower.slice(2).replace(/[a-f]/, (c) => c.toUpperCase())}`;
    assert.equal(checkConfigValue({ address: lower, codeHash: h }).state, "set");
    assert.equal(checkConfigValue({ address: factory, codeHash: h }).state, "set");
    if (bad !== factory) assert.equal(checkConfigValue({ address: bad, codeHash: h }).state, "unreadable");
  });

  it("the app's createRobinhoodAdapter ignores a smuggled factory or USDG", async () => {
    const reads: { address: string; functionName: string }[] = [];
    const client = {
      getCode: async () => "0x6000",
      getBlock: async () => ({ timestamp: 0n }),
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        reads.push({ address, functionName });
        if (["factory", "creator", "members"].includes(functionName)) return factory;
        if (functionName === "seat") return { collateral: 0n, g: 0n, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: 0, delinquentMarks: 0, roundsPaid: 0 };
        if (["status", "round", "paidBitmap", "joinedBitmap", "withdrawnBitmap", "receivedBitmap", "defaultedBitmap", "delinquentBitmap"].includes(functionName)) return 0;
        if (functionName === "n") return 3n;
        return 0n;
      },
    };
    const evil = "0x000000000000000000000000000000000000dEaD";
    const deps = { publicClient: client, walletClient: {}, account: evil, circle: factory, factory: { address: evil, codeHash: keccak256("0x00") }, usdg: evil };
    const ad = createRobinhoodAdapter(deps as never);
    assert.deepEqual(await ad.trust(), { ok: false, reason: "not-deployed" }, "the trusted factory (null) is used, not the smuggled one");
    await ad.readCircle("");
    const bal = reads.find((r) => r.functionName === "balanceOf");
    assert.equal(bal?.address.toLowerCase(), USDG.toLowerCase(), "the real USDG is read, not the smuggled token");
  });

  it("app/ outside src: no alias fields, no module files, no extensionless files", () => {
    assert.deepEqual(appTreeRules(), [], "the real app passes");
    const mk = () => {
      const d = mkdtempSync(join(tmpdir(), "trust-app-"));
      writeFileSync(join(d, "package.json"), '{"name":"x"}');
      writeFileSync(join(d, "next.config.mjs"), "export default {};");
      writeFileSync(join(d, "next-env.d.ts"), "");
      mkdirSync(join(d, "src"));
      return d;
    };
    assert.deepEqual(appTreeRules(mk()), []);
    for (const [field] of [["imports"], ["exports"], ["browser"]]) {
      const d = mk();
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", [field!]: { "#a": "./a.ts" } }));
      assert.match(appTreeRules(d).join(), new RegExp(`"${field}" field`));
    }
    const built = mk();
    mkdirSync(join(built, ".vercel/output/static/_next"), { recursive: true });
    writeFileSync(join(built, ".vercel/output/static/_next/chunk.js"), "x");
    mkdirSync(join(built, ".next/static"), { recursive: true });
    writeFileSync(join(built, ".next/static/chunk.js"), "x");
    assert.deepEqual(appTreeRules(built), [], "build output (.next, .vercel) is not source; scanTree checks it");
    const d = mk();
    mkdirSync(join(d, "rhdev"));
    writeFileSync(join(d, "rhdev/x.ts"), 'export * from "../src/lib/robinhood/adapter-core";');
    writeFileSync(join(d, "config"), "export const X = 1;");
    const f = appTreeRules(d).join("\n");
    assert.match(f, /rhdev\/x\.ts: module files outside app\/src/);
    assert.match(f, /app\/config: files without an extension/);
  });

  it("an extensionless file in app/src is refused (the bundler tries the bare name first)", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-noext-"));
    cpSync(new URL("../app/src", import.meta.url), dir, { recursive: true });
    writeFileSync(join(dir, "lib/robinhood/config"), "export const TRUSTED_FACTORY = null;");
    assert.match(moduleShadows(dir).join(), /lib\/robinhood\/config: files without an extension/);
  });

  it("the bundle scan allows only USDG, the zero address, viem's placeholder and the trusted factory", () => {
    const next = () => {
      const d = mkdtempSync(join(tmpdir(), "trust-next-"));
      mkdirSync(join(d, "static/chunks"), { recursive: true });
      mkdirSync(join(d, "server/app"), { recursive: true });
      writeFileSync(join(d, "static/chunks/a.js"), `const u="${USDG}";const z="0x0000000000000000000000000000000000000000";`);
      writeFileSync(join(d, "server/app/page.js"), 'const e="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";');
      return d;
    };
    assert.deepEqual(bundleAddresses(next(), null), []);
    const withRogue = next();
    writeFileSync(join(withRogue, "static/chunks/b.js"), `x("${other}")`);
    assert.match(bundleAddresses(withRogue, null).join(), new RegExp(`${other.toLowerCase()}.*not USDG or the trusted factory`));
    const withFactory = next();
    writeFileSync(join(withFactory, "server/app/x.html"), `<a>${factory}</a>`);
    assert.deepEqual(bundleAddresses(withFactory, factory), [], "a set factory present in the build passes");
    assert.match(bundleAddresses(next(), factory).join(), /does not contain the trusted factory/);
    assert.match(bundleAddresses(join(tmpdir(), "no-such-next-dir"), null).join(), /no complete Next build/);
    const noUsdg = next();
    writeFileSync(join(noUsdg, "static/chunks/a.js"), "");
    assert.match(bundleAddresses(noUsdg, null).join(), /does not contain USDG/);
  });

  it("addresses inside hex data are found: approve/transfer calldata and padded words, with or without 0x", () => {
    const a = other.toLowerCase().slice(2);
    const word = `${"0".repeat(24)}${a}`;
    assert.deepEqual(addressesIn(`x="0x095ea7b3${word}${"f".repeat(64)}"`), [`0x${a}`], "approve(spender, max)");
    assert.deepEqual(addressesIn(`x="a9059cbb${word}${"0".repeat(63)}1"`), [`0x${a}`], "transfer without 0x");
    assert.deepEqual(addressesIn(`topic="0x${word}"`), [`0x${a}`], "a log topic");
    assert.ok(addressesIn(`x="0x12345670${word}"`).length > 0, "a selector ending in 0 still yields a (shifted) candidate");
    assert.deepEqual(addressesIn(`n="${"0".repeat(57)}6000526"`), [], "small padded numbers are not addresses");
    assert.deepEqual(addressesIn(`u="${USDG}"`), [USDG.toLowerCase()]);
  });

  it("the bundle scan reads app/public and hex data", () => {
    const d = mkdtempSync(join(tmpdir(), "trust-next2-"));
    mkdirSync(join(d, ".next/static/chunks"), { recursive: true });
    mkdirSync(join(d, ".next/server/app"), { recursive: true });
    mkdirSync(join(d, "public"));
    writeFileSync(join(d, ".next/static/chunks/a.js"), `const u="${USDG}";`);
    assert.deepEqual(bundleAddresses(join(d, ".next"), null), []);
    writeFileSync(join(d, "public/token.json"), `{"token":"${other}"}`);
    assert.match(bundleAddresses(join(d, ".next"), null).join(), new RegExp(other.toLowerCase()));
    writeFileSync(join(d, "public/token.json"), "{}");
    writeFileSync(join(d, ".next/static/chunks/b.js"), `data:"0x095ea7b3${"0".repeat(24)}${other.slice(2)}${"f".repeat(64)}"`);
    assert.match(bundleAddresses(join(d, ".next"), null).join(), new RegExp(other.toLowerCase()));
  });

  it("trust and transaction code may not read environment variables", () => {
    assert.deepEqual(noEnvInTrustCode(), [], "the real app passes");
    const dir = mkdtempSync(join(tmpdir(), "trust-env-"));
    cpSync(new URL("../app/src", import.meta.url), dir, { recursive: true });
    writeFileSync(join(dir, "lib/robinhood/spender.ts"), "export const S = process.env.NEXT_PUBLIC_SPENDER;");
    assert.match(noEnvInTrustCode(dir).join(), /lib\/robinhood\/spender\.ts reads environment variables/);
  });

  it("the prebuilt artifact scan reads every file, refuses links leaving it, and its digest moves with any byte", () => {
    const mk = () => {
      const d = mkdtempSync(join(tmpdir(), "trust-vo-"));
      mkdirSync(join(d, "static/_next"), { recursive: true });
      mkdirSync(join(d, "functions/page.func"), { recursive: true });
      writeFileSync(join(d, "static/_next/a.js"), `u="${USDG}"`);
      writeFileSync(join(d, "functions/page.func/index.js"), "module.exports = 1;");
      writeFileSync(join(d, "config.json"), "{}");
      return d;
    };
    const ok = mk();
    assert.deepEqual(scanTree(ok, null), []);
    const d1 = artifactDigest(ok);
    assert.equal(artifactDigest(ok).sha256, d1.sha256, "stable");
    writeFileSync(join(ok, "config.json"), "{ }");
    assert.notEqual(artifactDigest(ok).sha256, d1.sha256, "one byte changes the digest");
    const rogue = mk();
    writeFileSync(join(rogue, "functions/page.func/weird.bin"), `\x00${other}\x00`);
    assert.match(scanTree(rogue, null).join(), new RegExp(other.toLowerCase()), "any file type is scanned");
    const leaky = mk();
    symlinkSync("/etc", join(leaky, "functions/escape"));
    assert.match(scanTree(leaky, null).join(), /link leaves the artifact/);
    assert.match(scanTree(ok, factory).join(), /does not contain the trusted factory/);
    assert.match(scanTree(join(tmpdir(), "no-such-artifact"), null).join(), /no artifact directory/);
  });

  it("files the deploy uploads from outside the output must exist and stay in the project", () => {
    const proj = mkdtempSync(join(tmpdir(), "trust-proj-"));
    const out = join(proj, ".vercel/output");
    mkdirSync(join(out, "functions/p.func"), { recursive: true });
    mkdirSync(join(proj, ".next/server"), { recursive: true });
    writeFileSync(join(proj, ".next/server/page.js"), `u="${USDG}"`);
    const cfg = (m: Record<string, string>) => writeFileSync(join(out, "functions/p.func/.vc-config.json"), JSON.stringify({ filePathMap: m }));
    cfg({ ".next/server/page.js": ".next/server/page.js" });
    assert.deepEqual(uploadSet(out, proj).failures, []);
    assert.equal(uploadSet(out, proj).files.length, 1);
    cfg({ "gone.js": ".next/server/gone.js" });
    assert.match(uploadSet(out, proj).failures.join(), /missing/);
    cfg({ "passwd": "../../../../../../../../etc/hostname" });
    assert.match(uploadSet(out, proj).failures.join(), /outside the project/);
  });

  it("the USDG the adapter approves is the USDG the gate pins", async () => {
    assert.deepEqual(await usdgMatches(), []);
  });

  it("the CLI passes on the committed (null) config", () => {
    const out = execFileSync("npx", ["tsx", "ops/trust-config.ts", "--rpc", RPC], { encoding: "utf8" });
    assert.match(out, /TRUSTED_FACTORY is null, config.ts has its fixed shape, and only adapter.ts imports it/);
  });
});
