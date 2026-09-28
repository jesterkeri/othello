/**
 * CI job `trust-config` (ARB-DESIGN r9 sections 7.1 and 9.1). Fails closed.
 *
 * While app/src/lib/robinhood/config.ts has TRUSTED_FACTORY = null, the page is read-only and this passes.
 * Once it is non-null, every one of these must hold, or the job fails:
 *   1. the committed broadcast receipt (evm/broadcast/DeployFactory.s.sol/46630/run-latest.json) is for chain
 *      46630, has one successful CREATE of OthelloFactory with constructor argument USDG, and its
 *      contractAddress equals the config address;
 *   2. the receipt's commit (the reviewed commit Joshua deployed from) is an ancestor of HEAD, and since it the
 *      ONLY files changed are config.ts, the receipt and Markdown notes (no code, build config or dependency);
 *   3. keccak256(eth_getCode(address)) on the chain equals the config codeHash;
 *   4. the reviewed source's compiled runtime (evm/out, immutables filled with USDG) hashes to that same value,
 *      which ties the live code to this exact compiler, source and constructor argument;
 *   5. the chain itself confirms the receipt's deployment transaction: a contract creation whose input is exactly
 *      the reviewed init code plus USDG, successful, creating that address (so no lookalike with other init code).
 * Always: config.ts has a fixed shape (TypeScript AST: `null` or `Object.freeze({address, codeHash})` of two
 * string literals, nothing computed), its imported value equals that literal, and in app/src only
 * lib/robinhood/adapter.ts may import ./config or ./adapter-core (the only modules that take or hold a factory).
 * Limit: a static gate cannot prove that code written to deceive it is harmless; that is the reviews' job. It
 * catches mistakes and any change made after the review-2 SHIP.
 *
 *   npx tsx ops/trust-config.ts [--rpc https://rpc.testnet.chain.robinhood.com]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
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
 * Reads config.ts by its TypeScript syntax tree against a fixed template. Allowed statements: type-only imports,
 * `export type TrustedFactory = …`, and exactly one `export const TRUSTED_FACTORY: TrustedFactory | null = X;`
 * where X is `null` or `Object.freeze({ address: "<literal>", codeHash: "<literal>" })`. Anything else,
 * including a value computed at run time (which could differ between Node and the browser), is unreadable.
 */
export function configFromSource(src: string): TrustedConfig {
  const sf = ts.createSourceFile("config.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let value: TrustedConfig | null = null;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) continue;
    if (ts.isTypeAliasDeclaration(st) && st.name.text === "TrustedFactory") continue;
    if (!ts.isVariableStatement(st) || value) return { state: "unreadable" };
    const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const decls = st.declarationList.declarations;
    if (!exported || !(st.declarationList.flags & ts.NodeFlags.Const) || decls.length !== 1) return { state: "unreadable" };
    const d = decls[0]!;
    if (!ts.isIdentifier(d.name) || d.name.text !== "TRUSTED_FACTORY" || !d.initializer) return { state: "unreadable" };
    if (d.type?.getText(sf).replace(/\s+/g, "") !== "TrustedFactory|null") return { state: "unreadable" };
    const init = d.initializer;
    if (init.kind === ts.SyntaxKind.NullKeyword) {
      value = { state: "null" };
      continue;
    }
    if (!ts.isCallExpression(init) || init.expression.getText(sf) !== "Object.freeze" || init.arguments.length !== 1) {
      return { state: "unreadable" };
    }
    const obj = init.arguments[0]!;
    if (!ts.isObjectLiteralExpression(obj) || obj.properties.length !== 2) return { state: "unreadable" };
    const lit: Record<string, string> = {};
    for (const pr of obj.properties) {
      if (!ts.isPropertyAssignment(pr) || !ts.isIdentifier(pr.name) || !ts.isStringLiteral(pr.initializer)) {
        return { state: "unreadable" };
      }
      lit[pr.name.text] = pr.initializer.text;
    }
    value = checkConfigValue(lit);
    if (value.state !== "set") return { state: "unreadable" };
  }
  return value ?? { state: "unreadable" };
}

/** The config as the app sees it: the AST template, AND the module's actual exported value must agree. */
export async function loadConfig(file: string = PATHS.config): Promise<TrustedConfig> {
  let fromSource: TrustedConfig;
  try {
    fromSource = configFromSource(readFileSync(file, "utf8"));
  } catch {
    return { state: "unreadable" };
  }
  if (fromSource.state === "unreadable") return fromSource;
  try {
    const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Record<string, unknown>;
    const imported = checkConfigValue(mod.TRUSTED_FACTORY);
    if (imported.state !== fromSource.state) return { state: "unreadable" };
    if (imported.state === "set" && fromSource.state === "set" &&
        (imported.address !== fromSource.address || imported.codeHash !== fromSource.codeHash)) return { state: "unreadable" };
    if (fromSource.state === "set" && !Object.isFrozen(mod.TRUSTED_FACTORY)) return { state: "unreadable" };
    return fromSource;
  } catch {
    return { state: "unreadable" };
  }
}

const GUARDED = ["lib/robinhood/config", "lib/robinhood/adapter-core"];

/**
 * The import boundary: in app/src only lib/robinhood/adapter.ts may import (statically, dynamically, by
 * require or by re-export) the config module or the factory-injectable core, apart from type-only imports.
 * Module specifiers are read from the TypeScript syntax tree and resolved (`@/…` and relative paths), so a
 * renamed import is still an import. A non-literal dynamic import or require anywhere in app/src also fails.
 */
export function importBoundary(appSrc: string = `${ROOT}app/src`): string[] {
  const f: string[] = [];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(n)) files.push(p);
    }
  };
  walk(appSrc);
  const allowed = join(appSrc, "lib/robinhood/adapter.ts");
  const resolveSpec = (from: string, spec: string): string | null => {
    let abs: string;
    if (spec.startsWith("@/")) abs = join(appSrc, spec.slice(2));
    else if (spec.startsWith(".")) abs = join(from, "..", spec);
    else return null;
    const rel = abs.slice(appSrc.length + 1).replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, "").replace(/\/index$/, "");
    return rel;
  };
  for (const file of files) {
    const rel = file.slice(appSrc.length + 1);
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const visit = (n: ts.Node) => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const typeOnly = ts.isImportDeclaration(n) ? Boolean(n.importClause?.isTypeOnly) : n.isTypeOnly;
        if (!typeOnly) hits.push(n.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
                 ts.isStringLiteral(n.moduleReference.expression)) {
        hits.push(n.moduleReference.expression.text);
      } else if (ts.isCallExpression(n) &&
                 (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        const a0 = n.arguments[0];
        if (a0 && (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0))) hits.push(a0.text);
        else f.push(`${rel}: a dynamic import or require with a computed path`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const spec of hits) {
      const target = resolveSpec(file, spec);
      if (target && GUARDED.includes(target) && file !== allowed) f.push(`${rel} imports ${spec}; only lib/robinhood/adapter.ts may`);
    }
  }
  return f;
}

/** Paths changed since `commit` (null if it is not an ancestor of HEAD or git fails). */
export function changedSince(commit: string | undefined): string[] | null {
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) return null;
  try {
    execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", commit, "HEAD"]);
    const out = execFileSync("git", ["-C", ROOT, "diff", "--name-only", commit, "HEAD"], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** After the reviewed deploy, only the config, the receipt and Markdown notes may change. */
export const CONFIG_COMMIT_ALLOWS = (p: string) =>
  p === "app/src/lib/robinhood/config.ts" || p === "evm/broadcast/DeployFactory.s.sol/46630/run-latest.json" || /\.md$/.test(p);

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
  /** Paths changed from the receipt's commit to HEAD, or null if that commit is not an ancestor of HEAD. */
  changedSinceReceipt: string[] | null;
  /** The deployment transaction and its receipt as the CHAIN reports them (looked up by the receipt's hash). */
  chainDeployTx: { input: Hex; to: string | null } | null;
  chainDeployReceipt: { status: string; contractAddress: string | null } | null;
  /** Failures from importBoundary(). */
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
  if (i.changedSinceReceipt === null) f.push(`receipt commit ${r.commit ?? "(none)"} is not an ancestor of HEAD`);
  else {
    const extra = i.changedSinceReceipt.filter((p) => !CONFIG_COMMIT_ALLOWS(p));
    if (extra.length) f.push(`since the deployed commit, files other than the config, receipt and notes changed: ${extra.join(", ")}`);
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
  const trustSources = importBoundary();
  if (config.state === "null" && !trustSources.length) {
    console.log("trust-config: TRUSTED_FACTORY is null, config.ts has its fixed shape, and only adapter.ts imports it; the Robinhood page offers no action.");
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
    changedSinceReceipt: changedSince(receipt?.commit),
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
