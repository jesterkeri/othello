/**
 * CI job `trust-config` (ARB-DESIGN r9 sections 7.1 and 9.1). Fails closed.
 *
 * While app/src/lib/robinhood/config.ts has TRUSTED_FACTORY = null, the page is read-only and this passes.
 * Once it is non-null, every one of these must hold, or the job fails:
 *   1. the committed broadcast receipt (evm/broadcast/DeployFactory.s.sol/46630/run-latest.json) is for chain
 *      46630, has one successful CREATE of OthelloFactory with constructor argument USDG, and its
 *      contractAddress equals the config address;
 *   2. the receipt's commit is an ancestor of HEAD and nothing under evm/src or the deploy script changed since;
 *   3. keccak256(eth_getCode(address)) on the chain equals the config codeHash;
 *   4. the reviewed source's compiled runtime (evm/out, immutables filled with USDG) hashes to that same value,
 *      which ties the live code to this exact compiler, source and constructor argument;
 *   5. the chain itself confirms the receipt's deployment transaction: a contract creation whose input is exactly
 *      the reviewed init code plus USDG, successful, creating that address (so no lookalike with other init code).
 * Always: config.ts is loaded as a module (never parsed as text), and every trust check in app/src reads it.
 *
 *   npx tsx ops/trust-config.ts [--rpc https://rpc.testnet.chain.robinhood.com]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeAbiParameters, getAddress, isAddress, isHex, keccak256, type Address, type Hex } from "viem";

export const ROBINHOOD_TESTNET_ID = 46630;
export const USDG: Address = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PATHS = {
  config: `${ROOT}app/src/lib/robinhood/config.ts`,
  receipt: `${ROOT}evm/broadcast/DeployFactory.s.sol/46630/run-latest.json`,
  artifact: `${ROOT}evm/out/OthelloFactory.sol/OthelloFactory.json`,
};

export type TrustedConfig = { state: "null" } | { state: "set"; address: Address; codeHash: Hex } | { state: "unreadable" };

/**
 * The exact value the page imports, checked for shape. Anything but `null` or an object with exactly
 * `address` (a valid address) and `codeHash` (32 bytes) is unreadable, which fails.
 */
export function checkConfigValue(v: unknown): TrustedConfig {
  if (v === null) return { state: "null" };
  if (typeof v !== "object" || Array.isArray(v)) return { state: "unreadable" };
  const keys = Object.keys(v).sort();
  if (keys.length !== 2 || keys[0] !== "address" || keys[1] !== "codeHash") return { state: "unreadable" };
  const { address, codeHash } = v as { address: unknown; codeHash: unknown };
  if (typeof address !== "string" || !isAddress(address, { strict: false })) return { state: "unreadable" };
  if (typeof codeHash !== "string" || !isHex(codeHash) || codeHash.length !== 66) return { state: "unreadable" };
  return { state: "set", address: getAddress(address.toLowerCase()), codeHash: codeHash.toLowerCase() as Hex };
}

/**
 * Loads config.ts the way the app does (as a module) and reads the exported TRUSTED_FACTORY. Text is never
 * parsed: a commented-out line or a second literal cannot change what is checked. A load error is unreadable.
 */
export async function loadConfig(file: string = PATHS.config): Promise<TrustedConfig> {
  try {
    const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Record<string, unknown>;
    if (!("TRUSTED_FACTORY" in mod)) return { state: "unreadable" };
    return checkConfigValue(mod.TRUSTED_FACTORY);
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * Every place in app/src that trusts a factory must take it from config.ts: each call to checkTrusted or
 * createRobinhoodAdapter must pass TRUSTED_FACTORY, imported from the config module, and no other file may
 * declare a TRUSTED_FACTORY. Returns failures (empty = pass). Applies whether or not the config is set.
 */
export function singleSourceOfTrust(appSrc: string = `${ROOT}app/src`): string[] {
  const f: string[] = [];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(appSrc);
  const configFile = join(appSrc, "lib/robinhood/config.ts");
  const adapterFile = join(appSrc, "lib/robinhood/adapter.ts");
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(appSrc.length + 1);
    if (file !== configFile && /\b(const|let|var)\s+TRUSTED_FACTORY\b/.test(src)) f.push(`${rel} declares its own TRUSTED_FACTORY`);
    if (file === adapterFile) continue;
    const calls = [...src.matchAll(/\b(checkTrusted|createRobinhoodAdapter)\s*\(/g)];
    if (!calls.length) continue;
    if (!/import\s*\{[^}]*\bTRUSTED_FACTORY\b[^}]*\}\s*from\s*["'](@\/lib\/robinhood\/config|\.\.?\/[^"']*config)["']/.test(src)) {
      f.push(`${rel} trusts a factory without importing TRUSTED_FACTORY from the config module`);
    }
    for (const c of calls) {
      const tail = src.slice(c.index!, c.index! + 600);
      const ok = c[1] === "checkTrusted"
        ? /^checkTrusted\s*\([^;]*?,\s*TRUSTED_FACTORY\s*\)/s.test(tail)
        : /^createRobinhoodAdapter\s*\(\s*\{[^}]*\bfactory:\s*TRUSTED_FACTORY\b/s.test(tail);
      if (!ok) f.push(`${rel}: ${c[1]} is not given TRUSTED_FACTORY`);
    }
  }
  return f;
}

/** The factory's runtime bytecode as the reviewed source compiles it, with its immutables filled. */
export function expectedRuntime(artifact: {
  bytecode?: { object: string };
  deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> };
}, usdg: Address): Hex {
  const hex = artifact.deployedBytecode.object.replace(/^0x/, "");
  const bytes = Buffer.from(hex, "hex");
  const word = Buffer.from(usdg.slice(2).toLowerCase().padStart(64, "0"), "hex");
  const refs = Object.values(artifact.deployedBytecode.immutableReferences ?? {});
  if (refs.length !== 1) throw new Error(`expected exactly one immutable (usdg), found ${refs.length}`);
  for (const r of refs[0]!) {
    if (r.length !== 32) throw new Error("immutable length is not 32");
    word.copy(bytes, r.start);
  }
  return `0x${bytes.toString("hex")}`;
}

type Receipt = {
  chain?: number;
  commit?: string;
  transactions?: { hash?: string; transactionType?: string; contractName?: string; contractAddress?: string; arguments?: string[] }[];
  receipts?: { contractAddress?: string | null; status?: string }[];
};

export type Inputs = {
  config: TrustedConfig;
  receipt: Receipt | null;
  artifact: Parameters<typeof expectedRuntime>[0];
  chainCode: Hex | null;
  chainId: number | null;
  /** true if the receipt's commit is an ancestor of HEAD and evm/src + the deploy script are unchanged since. */
  sourceUnchangedSinceReceipt: boolean | null;
  /** The deployment transaction and its receipt as the CHAIN reports them (looked up by the receipt's hash). */
  chainDeployTx: { input: Hex; to: string | null } | null;
  chainDeployReceipt: { status: string; contractAddress: string | null } | null;
  /** Failures from singleSourceOfTrust(). */
  trustSources: string[];
};

/** The exact creation input the reviewed source produces: init code + abi-encoded USDG. */
export function expectedCreationInput(artifact: { bytecode: { object: string } }, usdg: Address): Hex {
  const init = artifact.bytecode.object.replace(/^0x/, "");
  return `0x${init}${encodeAbiParameters([{ type: "address" }], [usdg]).slice(2)}`.toLowerCase() as Hex;
}

/** Every failure, in plain words. Empty means pass. */
export function verify(i: Inputs): string[] {
  if (i.trustSources.length) return i.trustSources;
  if (i.config.state === "null") return [];
  if (i.config.state === "unreadable") return ["TRUSTED_FACTORY is neither null nor { address, codeHash } literals"];
  const { address, codeHash } = i.config;
  const f: string[] = [];
  const r = i.receipt;
  if (!r) return ["TRUSTED_FACTORY is set but the broadcast receipt is missing"];
  if (r.chain !== ROBINHOOD_TESTNET_ID) f.push(`receipt chain is ${r.chain}, not ${ROBINHOOD_TESTNET_ID}`);
  const creates = (r.transactions ?? []).filter((t) => t.transactionType === "CREATE" && t.contractName === "OthelloFactory");
  if (creates.length !== 1) f.push(`receipt has ${creates.length} OthelloFactory CREATEs, need exactly 1`);
  const tx = creates[0];
  if (tx) {
    if (!tx.contractAddress || tx.contractAddress.toLowerCase() !== address.toLowerCase()) {
      f.push(`receipt deployed ${tx.contractAddress}, config says ${address}`);
    }
    const arg = tx.arguments?.[0];
    if (!arg || arg.toLowerCase() !== USDG.toLowerCase()) f.push(`factory constructor argument is ${arg}, not USDG ${USDG}`);
    const rc = (r.receipts ?? []).find((x) => x.contractAddress?.toLowerCase() === address.toLowerCase());
    if (!rc || rc.status !== "0x1") f.push("no successful receipt for the factory's deployment");
  }
  if (i.sourceUnchangedSinceReceipt !== true) {
    f.push(`receipt commit ${r.commit ?? "(none)"} is not an ancestor of HEAD with evm/src and the deploy script unchanged`);
  }
  if (i.chainId !== ROBINHOOD_TESTNET_ID) f.push(`RPC chain id is ${i.chainId}, not ${ROBINHOOD_TESTNET_ID}`);
  // The receipt file is only a pointer: the chain must confirm the deployment itself. Identical runtime code with
  // other init code (e.g. pre-registering a circle in storage) fails here.
  if (!i.chainDeployTx) f.push("the chain has no deployment transaction for the receipt's hash");
  else {
    if (i.chainDeployTx.to !== null) f.push("the deployment transaction is not a contract creation");
    if (i.chainDeployTx.input.toLowerCase() !== expectedCreationInput(i.artifact as never, USDG)) {
      f.push("the deployment transaction's creation code is not the reviewed factory with USDG");
    }
  }
  if (!i.chainDeployReceipt || i.chainDeployReceipt.status !== "0x1") f.push("the chain reports no successful deployment receipt");
  else if (i.chainDeployReceipt.contractAddress?.toLowerCase() !== address.toLowerCase()) {
    f.push(`the chain says that transaction created ${i.chainDeployReceipt.contractAddress}, not ${address}`);
  }
  if (!i.chainCode || i.chainCode === "0x") f.push(`no code at ${address} on chain`);
  else if (keccak256(i.chainCode) !== codeHash) f.push(`live code hash ${keccak256(i.chainCode)} differs from config ${codeHash}`);
  const expected = keccak256(expectedRuntime(i.artifact, USDG));
  if (expected !== codeHash) f.push(`the reviewed source compiles to ${expected}, config says ${codeHash}`);
  return f;
}

export function sourceUnchanged(commit: string | undefined): boolean {
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) return false;
  try {
    execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", commit, "HEAD"]);
    execFileSync("git", ["-C", ROOT, "diff", "--quiet", commit, "HEAD", "--", "evm/src", "evm/script/DeployFactory.s.sol"]);
    return true;
  } catch {
    return false;
  }
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function main() {
  const at = process.argv.indexOf("--rpc");
  const url = at > 0 ? process.argv[at + 1] : "https://rpc.testnet.chain.robinhood.com";
  if (!url) throw new Error("--rpc needs a URL");
  const config = await loadConfig();
  const trustSources = singleSourceOfTrust();
  if (config.state === "null" && !trustSources.length) {
    console.log("trust-config: TRUSTED_FACTORY is null and every trust check reads it; the Robinhood page offers no action.");
    return;
  }
  const receipt = existsSync(PATHS.receipt) ? (JSON.parse(readFileSync(PATHS.receipt, "utf8")) as Receipt) : null;
  const artifact = JSON.parse(readFileSync(PATHS.artifact, "utf8"));
  let chainCode: Hex | null = null;
  let chainId: number | null = null;
  let chainDeployTx: Inputs["chainDeployTx"] = null;
  let chainDeployReceipt: Inputs["chainDeployReceipt"] = null;
  if (config.state === "set") {
    chainId = Number.parseInt(String(await rpc(url, "eth_chainId", [])), 16);
    chainCode = (await rpc(url, "eth_getCode", [config.address, "latest"])) as Hex;
    const hash = receipt?.transactions?.find((t) => t.contractName === "OthelloFactory")?.hash;
    if (hash && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
      chainDeployTx = (await rpc(url, "eth_getTransactionByHash", [hash])) as Inputs["chainDeployTx"];
      chainDeployReceipt = (await rpc(url, "eth_getTransactionReceipt", [hash])) as Inputs["chainDeployReceipt"];
    }
  }
  const failures = verify({
    config, receipt, artifact, chainCode, chainId, chainDeployTx, chainDeployReceipt, trustSources,
    sourceUnchangedSinceReceipt: sourceUnchanged(receipt?.commit),
  });
  if (failures.length) {
    console.error("trust-config FAILED:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log(`trust-config: ${config.state === "set" ? config.address : ""} verified against the receipt, the chain's deployment, its live code and the reviewed source.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("trust-config FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
