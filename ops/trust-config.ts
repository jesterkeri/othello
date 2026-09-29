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
 * With --build <.next dir> (CI always passes it after `next build`): every address in the build output and app/public
 * (0x literals, and address words inside hex data) is
 * USDG, the zero address, viem's native placeholder or the trusted factory, and a set factory must appear in it.
 * Always: app/ has no alias fields in package.json and no module files outside src (except next.config.mjs and
 * next-env.d.ts), no extensionless files, chain.ts's USDG equals the pinned USDG,
 * app/src holds no JavaScript module and no two files differing only by extension (so the bundler loads
 * the file checked here), next.config.mjs and tsconfig.json match pinned hashes, config.ts has a fixed shape (TypeScript AST: `null` or `Object.freeze({address, codeHash})` of two
 * string literals, nothing computed), its imported value equals that literal, and in app/src only
 * lib/robinhood/adapter.ts may import ./config or ./adapter-core (the only modules that take or hold a factory).
 * Limit: a static gate cannot prove that code written to deceive it is harmless; that is the reviews' job. It
 * catches mistakes and any change made after the review-2 SHIP.
 *
 *   npx tsx ops/trust-config.ts [--rpc https://rpc.testnet.chain.robinhood.com]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { encodeAbiParameters, getAddress, isAddress, isHex, keccak256, type Address, type Hex } from "viem";

export const ROBINHOOD_TESTNET_ID = 46630;
/** The one Vercel CLI the release builds, scans and deploys with (its filePathMap upload rule is what uploadSet reads). */
export const VERCEL_CLI = "59.11.7";
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
  // strict: all-lowercase, or mixed case with a valid EIP-55 checksum (the page's viem calls are strict too)
  if (typeof address !== "string" || !isAddress(address)) return { state: "unreadable" };
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
      if (spec.startsWith("#")) { f.push(`${rel} uses a package.json subpath import (${spec}); not allowed in app/src`); continue; }
      const target = resolveSpec(file, spec);
      if (target && GUARDED.includes(target) && file !== allowed) f.push(`${rel} imports ${spec}; only lib/robinhood/adapter.ts may`);
    }
  }
  return f;
}

/** Module extensions Next's resolver may try for an import; a JS file would be tried before the .ts one. */
const MODULE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;

/**
 * What the bundler loads must be the file the gate checks: app/src may contain no JavaScript module files, and
 * no two files that differ only by module extension (so `config.js` or `config.tsx` cannot shadow `config.ts`).
 */
export function moduleShadows(appSrc: string = `${ROOT}app/src`): string[] {
  const f: string[] = [];
  const stems = new Map<string, string[]>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!n.includes(".")) f.push(`${p.slice(appSrc.length + 1)}: files without an extension are not allowed in app/src (the bundler tries the bare name first)`);
      else if (MODULE_EXT.test(n)) {
        const rel = p.slice(appSrc.length + 1);
        if (/\.(js|jsx|mjs|cjs)$/.test(n)) f.push(`${rel}: JavaScript module files are not allowed in app/src`);
        const stem = rel.replace(MODULE_EXT, "");
        stems.set(stem, [...(stems.get(stem) ?? []), rel]);
      }
    }
  };
  walk(appSrc);
  for (const [stem, files] of stems) if (files.length > 1) f.push(`${stem} resolves to more than one file: ${files.join(", ")}`);
  return f;
}

/**
 * Build files that can redirect an import (path aliases, webpack/turbopack resolve rules), pinned by sha256.
 * Changing either one means editing this list, which a review sees.
 */
export const PINNED_BUILD_FILES: Record<string, string> = {
  "app/next.config.mjs": "67c04765514b646bda06605f69bb6d7113d4c8f8871408cf2606ab478d39bb9e",
  "app/tsconfig.json": "8ca1ad27ebaba629ce060411aef2a0bc2e317becd7e66978aece1d2d0d4b6bde",
};

export function buildFilePins(root: string = ROOT): string[] {
  const f: string[] = [];
  for (const [rel, want] of Object.entries(PINNED_BUILD_FILES)) {
    const p = join(root, rel);
    if (!existsSync(p)) { f.push(`${rel} is missing`); continue; }
    const got = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (got !== want) f.push(`${rel} changed (sha256 ${got}); resolve rules must be reviewed and re-pinned in ops/trust-config.ts`);
  }
  for (const other of ["next.config.js", "next.config.ts", "next.config.cjs", "jsconfig.json"]) {
    if (existsSync(join(root, "app", other))) f.push(`app/${other} exists beside the pinned build files`);
  }
  return f;
}

/**
 * The rest of app/ (outside src, node_modules, .next, public): no alias fields in app/package.json (imports,
 * exports, browser), no module file except next.config.mjs and next-env.d.ts, no extensionless file. So nothing
 * outside app/src can stand in for, re-export or re-route a guarded module.
 */
export function appTreeRules(appDir: string = `${ROOT}app`): string[] {
  const f: string[] = [];
  const pkg = join(appDir, "package.json");
  if (existsSync(pkg)) {
    const j = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, unknown>;
    for (const k of ["imports", "exports", "browser"]) if (k in j) f.push(`app/package.json has an "${k}" field, which can re-route imports`);
  }
  // .next and .vercel are build output (gitignored, never from the repo; .vercel/output is checked by scanTree)
  const skip = new Set(["node_modules", ".next", ".vercel", "public", "src"]);
  const allowedModules = new Set(["next.config.mjs", "next-env.d.ts"]);
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = p.slice(appDir.length + 1);
      if (statSync(p).isDirectory()) {
        if (!(d === appDir && skip.has(n))) walk(p);
        continue;
      }
      if (!n.includes(".")) f.push(`app/${rel}: files without an extension are not allowed in app/`);
      else if (MODULE_EXT.test(n) && !/\.json$/.test(n) && !(d === appDir && allowedModules.has(n))) {
        f.push(`app/${rel}: module files outside app/src are not allowed`);
      }
    }
  };
  walk(appDir);
  return f;
}

/**
 * Code that decides trust or builds a transaction may not read environment variables: Vercel builds with its own
 * environment, so an address from NEXT_PUBLIC_* would never appear in the build CI scans.
 */
export function noEnvInTrustCode(appSrc: string = `${ROOT}app/src`): string[] {
  const f: string[] = [];
  for (const sub of ["lib/robinhood", "lib/core", "components/robinhood"]) {
    const d = join(appSrc, sub);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isFile() && /(process\.env|import\.meta\.env)/.test(readFileSync(p, "utf8"))) {
        f.push(`${sub}/${n} reads environment variables; trust and transaction code may not`);
      }
    }
  }
  return f;
}

/** Contract addresses that may appear in the built app (besides the trusted factory once it is set). */
export const BUNDLE_ADDRESS_ALLOWLIST = new Set([
  "0x0000000000000000000000000000000000000000", // zero address
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // viem's native-token placeholder
  USDG.toLowerCase(),
]);

/**
 * Scans the real build output (.next/static and .next/server) for 20-byte hex addresses. Every one must be on the
 * allowlist or be the trusted factory; once the factory is set it must appear. However an import is routed, a
 * hard-coded factory has to be in the bytes the browser receives.
 */
/** Every address in `text`: 0x-prefixed 20-byte literals, and 32-byte words holding an address inside hex data. */
export function addressesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) out.push(m[0].toLowerCase());
  // ABI-encoded data (calldata, topics, pad()): a word of 24 zero digits then 40 hex digits. Take the word at the
  // start of each run of >= 24 zeros; small padded numbers (whose first 4 address bytes are zero) are not addresses.
  for (const run of text.matchAll(/[0-9a-fA-F]{64,}/g)) {
    const hex = run[0];
    for (const z of hex.matchAll(/0{24,}/g)) {
      const cand = hex.slice(z.index! + 24, z.index! + 64);
      if (cand.length === 40 && !/^0{8}/.test(cand)) out.push(`0x${cand.toLowerCase()}`);
    }
  }
  return out;
}

export function bundleAddresses(nextDir: string, trusted: Address | null, publicDir: string = join(nextDir, "..", "public")): string[] {
  const f: string[] = [];
  const found = new Set<string>();
  const roots = ["static", "server"].map((r) => join(nextDir, r)).filter((r) => existsSync(r));
  if (roots.length !== 2) return [`no complete Next build at ${nextDir} (run next build first)`];
  // Files the page can fetch at run time are shipped with it: scan them too.
  if (existsSync(publicDir)) roots.push(publicDir);
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|html|rsc|json|txt|map|body|meta|svg|xml|csv|md|webmanifest)$/.test(n)) {
        for (const a of addressesIn(readFileSync(p, "utf8"))) found.add(a);
      }
    }
  };
  roots.forEach(walk);
  const want = trusted?.toLowerCase();
  for (const a of found) if (!BUNDLE_ADDRESS_ALLOWLIST.has(a) && a !== want) f.push(`the build contains address ${a}, which is not USDG or the trusted factory`);
  if (want && !found.has(want)) f.push(`the build does not contain the trusted factory ${trusted}`);
  if (!found.has(USDG.toLowerCase())) f.push("the build does not contain USDG");
  return f;
}

const MAX_SCANNED_FILE = 50 * 1024 * 1024;

/**
 * What `vercel pull` and `vercel build` (59.11.7) leave in `<project>/.vercel` for this app, and nothing else. `node`
 * holds only the build's `package-manifest.json` (dependency list; the deploy command never reads it).
 */
const VERCEL_DIR_ALLOWED = (n: string) =>
  n === "project.json" || n === "README.txt" || n === "output" || n === "node" || /^\.env\.[a-z]+\.local$/.test(n);

/**
 * Anything the pinned CLI's prebuilt deploy would upload or apply beyond `.vercel/output` and filePathMap sources.
 * vercel@59.11.7 (buildFileTree2, getLocalPathConfig) also uploads `<project>/.vercel/routes.json`, any
 * `microfrontends.json(c)` in the project outside node_modules and .git, and a `bulkRedirectsPath` named by the
 * project config, which it reads from `vercel.json`/`vercel.toml` or, failing those, the compiled
 * `<project>/.vercel/vercel.json`; and `settings.rootDirectory` in `.vercel/project.json` moves where it looks. So,
 * rather than list known extras: `<project>/.vercel` may hold only what pull and build write (VERCEL_DIR_ALLOWED), no
 * Vercel config file of any name may sit in the project dir, `rootDirectory` must be unset, and no microfrontends file
 * may exist. Each finding is a refusal (scanTree of a real `<project>/.vercel/output`, and ops/release-deploy.ts
 * before and after the upload); `.vercel/project.json` itself is in artifactDigest. Env files are only named, never read.
 * tests/release-deploy-*-adversary.spec.ts check this against the pinned CLI's own config reader and collector.
 */
export function cliExtraUploads(projectDir: string): string[] {
  const found: string[] = [];
  const vdir = join(projectDir, ".vercel");
  if (existsSync(vdir)) {
    for (const n of readdirSync(vdir)) if (!VERCEL_DIR_ALLOWED(n)) found.push(`.vercel/${n}`);
    const nodeDir = join(vdir, "node");
    if (existsSync(nodeDir)) {
      if (!lstatSync(nodeDir).isDirectory()) found.push(".vercel/node (not a directory)");
      else for (const n of readdirSync(nodeDir)) if (n !== "package-manifest.json") found.push(`.vercel/node/${n}`);
    }
    const pj = join(vdir, "project.json");
    if (existsSync(pj)) {
      try {
        const rd = (JSON.parse(readFileSync(pj, "utf8")) as { settings?: { rootDirectory?: unknown } }).settings?.rootDirectory;
        if (rd !== undefined && rd !== null && rd !== "" && rd !== ".") found.push(`.vercel/project.json settings.rootDirectory ${JSON.stringify(rd)}`);
      } catch {
        found.push(".vercel/project.json (unreadable)");
      }
    }
  }
  const walk = (d: string) => {
    let names: string[];
    try { names = readdirSync(d); } catch { found.push(`${relative(projectDir, d) || "."} (unreadable, so it cannot be checked)`); return; }
    for (const n of names) {
      if (n === "node_modules" || n === ".git") continue;
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (n === "microfrontends.json" || n === "microfrontends.jsonc") found.push(relative(projectDir, p).split(sep).join("/"));
    }
  };
  if (existsSync(projectDir)) {
    walk(projectDir);
    for (const n of readdirSync(projectDir)) if (/^(vercel|now)\.[^.]+$/i.test(n)) found.push(n);
  }
  return found.map((f) => `${f}: vercel deploy --prebuilt ${VERCEL_CLI} would upload or apply it, and this release uses none; remove it`);
}

/**
 * Files `vercel deploy --prebuilt` uploads from OUTSIDE the output directory: every function's `.vc-config.json`
 * `filePathMap` (output path → source path relative to the project dir, i.e. app/). Each source must exist and lie in
 * the project dir or in its node_modules' real location (node_modules may itself be a link).
 */
export function uploadSet(outDir: string, projectDir: string): {
  files: { key: string; path: string; link?: string }[];
  dirs: { key: string; path: string }[];
  failures: string[];
} {
  const failures: string[] = [];
  const files = new Map<string, { key: string; path: string; link?: string }>();
  const dirs = new Map<string, { key: string; path: string }>();
  const roots = [realpathSync(projectDir)];
  const nm = join(projectDir, "node_modules");
  if (existsSync(nm)) roots.push(realpathSync(nm));
  const inside = (p: string) => roots.some((r) => p === r || p.startsWith(r + sep));
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue; // a linked .func shares a real one, read where it lives
      if (st.isDirectory()) { walk(p); continue; }
      if (n !== ".vc-config.json") continue;
      let cfg: { filePathMap?: Record<string, string> };
      try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { failures.push(`${relative(outDir, p)}: unreadable`); continue; }
      for (const [key, v] of Object.entries(cfg.filePathMap ?? {})) {
        // The pinned CLI joins (buildFileTree2: `join(path, v)`), so for an absolute value it uploads `<project>/<v>`
        // while resolve() would read `v` itself: refused rather than interpreted (no real build has one). For a relative
        // value join and resolve agree; one that climbs out of the project is dropped by the CLI, and hashed here only
        // if it stays in the project or node_modules' real location (hashing more than is uploaded is harmless).
        if (isAbsolute(String(v))) { failures.push(`upload ${v}: an absolute filePathMap source`); continue; }
        const abs = resolve(projectDir, String(v));
        let real: string;
        try { real = realpathSync(abs); } catch { failures.push(`upload ${v}: missing`); continue; }
        if (!inside(real)) { failures.push(`upload ${v}: outside the project`); continue; }
        // a package link (pnpm) resolves to a folder: its needed files are listed as their own entries
        if (statSync(real).isDirectory()) dirs.set(key, { key, path: real });
        else files.set(real, { key, path: real, ...(lstatSync(abs).isSymbolicLink() ? { link: readlinkSync(abs) } : {}) });
      }
    }
  };
  walk(outDir);
  return { files: [...files.values()], dirs: [...dirs.values()], failures };
}

const projectOf = (outDir: string) => resolve(outDir, "..", "..");

/**
 * Scans EVERY file of a deployable artifact (e.g. `app/.vercel/output` from `vercel build`, the exact bytes
 * `vercel deploy --prebuilt` uploads). Every address found must be USDG, the zero address, viem's placeholder or the
 * trusted factory; a set factory and USDG must be present. Fails closed: a file over 50 MB, or a symbolic link that
 * resolves outside the artifact, is a failure, not a skip.
 */
export function scanTree(dir: string, trusted: Address | null, projectDir: string = projectOf(dir)): string[] {
  const f: string[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`no artifact directory at ${dir}`];
  const root = realpathSync(dir);
  const found = new Set<string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(p); } catch { f.push(`${relative(root, p)}: broken link`); continue; }
        if (target !== root && !target.startsWith(root + sep)) f.push(`${relative(root, p)}: link leaves the artifact (${target})`);
        continue; // its target is scanned where it lives inside the artifact
      }
      if (st.isDirectory()) { walk(p); continue; }
      if (st.size > MAX_SCANNED_FILE) { f.push(`${relative(root, p)}: ${st.size} bytes, too large to scan`); continue; }
      for (const a of addressesIn(readFileSync(p, "latin1"))) found.add(a);
    }
  };
  walk(root);
  // and every file the deploy uploads from outside the output (functions' filePathMap: .next/server, node_modules, …)
  const up = uploadSet(root, projectDir);
  f.push(...up.failures);
  // routes.json, microfrontends config, Vercel config: refused, not scanned. Only for a real `<project>/.vercel/output`
  // (what vercel build writes and the release deploys); ops/release-deploy.ts checks the project dir itself too.
  const standard = resolve(projectDir, ".vercel", "output");
  if (existsSync(standard) && root === realpathSync(standard)) f.push(...cliExtraUploads(projectDir));
  for (const u of up.files) {
    const st = statSync(u.path);
    if (st.size > MAX_SCANNED_FILE) { f.push(`upload ${u.key}: ${st.size} bytes, too large to scan`); continue; }
    for (const a of addressesIn(readFileSync(u.path, "latin1"))) found.add(a);
  }
  const want = trusted?.toLowerCase();
  for (const a of found) if (!BUNDLE_ADDRESS_ALLOWLIST.has(a) && a !== want) f.push(`the artifact contains address ${a}, which is not USDG or the trusted factory`);
  if (want && !found.has(want)) f.push(`the artifact does not contain the trusted factory ${trusted}`);
  if (!found.has(USDG.toLowerCase())) f.push("the artifact does not contain USDG");
  return f;
}

/**
 * One sha256 over what the deploy uploads: sorted `path<TAB>sha256` lines for the output directory (links as
 * `path<TAB>-> target`) and `upload:<filePathMap key><TAB>sha256` for each file uploaded from outside it. `lines` is the
 * full per-file list, written next to the release record so a reviewer can compare files directly (a Next build ID is
 * random, so a rebuild cannot reproduce the digest).
 */
export function artifactDigest(dir: string, projectDir: string = projectOf(dir)): { sha256: string; files: number; lines: string[] } {
  const root = realpathSync(dir);
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = relative(root, p).split(sep).join("/");
      const st = lstatSync(p);
      if (st.isSymbolicLink()) lines.push(`${rel}\t-> ${readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p);
      else lines.push(`${rel}\t${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  const up = uploadSet(root, projectDir);
  // a linked source is uploaded as its link text, so the text is bound as well as the target's bytes
  for (const u of up.files) {
    lines.push(`upload:${u.key}\t${createHash("sha256").update(readFileSync(u.path)).digest("hex")}${u.link === undefined ? "" : `\t-> ${u.link}`}`);
  }
  // not uploaded, but the deploy reads it (project, org, settings): bound so it cannot change after the record
  const pj = join(projectDir, ".vercel", "project.json");
  if (existsSync(pj)) lines.push(`project:.vercel/project.json\t${createHash("sha256").update(readFileSync(pj)).digest("hex")}`);
  for (const u of up.dirs) lines.push(`upload:${u.key}\t-> ${relative(realpathSync(projectDir), u.path)}`);
  lines.sort();
  return { sha256: createHash("sha256").update(lines.join("\n")).digest("hex"), files: lines.length, lines };
}

export type ReleaseRecord = {
  commit: string; artifactSha256: string; files: number; trustedFactory: Address | null; scannedAt: string;
  vercelCli: string; deploy: string; fileList: string;
  deploymentUrl: string | null; target: "preview" | "production" | null; deployedAt: string | null;
};

/** Writes the release record and its per-file list (`<record>.files.txt`); ops/release-deploy.ts fills the deployment. */
export function writeRecord(
  file: string, dg: { sha256: string; files: number; lines: string[] }, commit: string, trusted: Address | null, root: string = ROOT,
) {
  const fileList = file.replace(/\.json$/, ".files.txt");
  const rec: ReleaseRecord = {
    commit, artifactSha256: dg.sha256, files: dg.files, trustedFactory: trusted, scannedAt: new Date().toISOString(),
    vercelCli: VERCEL_CLI, deploy: `npx tsx ops/release-deploy.ts --record ${relative(root, file)}`, fileList: relative(root, fileList),
    deploymentUrl: null, target: null, deployedAt: null,
  };
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  writeFileSync(fileList, dg.lines.join("\n") + "\n");
}

/** The USDG the adapter approves (app/src/lib/robinhood/chain.ts) must be the USDG this gate pins. */
export async function usdgMatches(): Promise<string[]> {
  try {
    const mod = (await import(`${pathToFileURL(`${ROOT}app/src/lib/robinhood/chain.ts`).href}?t=${Date.now()}`)) as { USDG?: string };
    return mod.USDG?.toLowerCase() === USDG.toLowerCase() ? [] : [`chain.ts USDG is ${mod.USDG}, not ${USDG}`];
  } catch (e) {
    return [`chain.ts could not be loaded: ${e instanceof Error ? e.message : e}`];
  }
}

/** Paths changed since `commit` (null if it is not an ancestor of HEAD or git fails). */
export function changedSince(commit: string | undefined): string[] | null {
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) return null;
  try {
    execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", commit, "HEAD"]);
    // --no-renames: a rename is listed as its deletion AND its addition, so `git mv X X.md` cannot hide X.
    const out = execFileSync("git", ["-C", ROOT, "diff", "--no-renames", "--name-only", commit, "HEAD"], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** After the reviewed deploy, only the config, the receipt and Markdown notes may change. */
export const CONFIG_COMMIT_ALLOWS = (p: string) =>
  p === "app/src/lib/robinhood/config.ts" || p === "evm/broadcast/DeployFactory.s.sol/46630/run-latest.json" ||
  p === "release/robinhood-prebuilt.json" || p === "release/robinhood-prebuilt.files.txt" || /\.md$/.test(p);

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
  const trustSources = [
    ...importBoundary(), ...moduleShadows(), ...appTreeRules(), ...buildFilePins(), ...noEnvInTrustCode(), ...(await usdgMatches()),
  ];
  if (trustSources.length) {
    // Where the page's factory comes from is wrong: say so before anything else is read.
    console.error("trust-config FAILED:\n- " + trustSources.join("\n- "));
    process.exit(1);
  }
  const b = process.argv.indexOf("--build");
  if (b > 0) {
    const nextDir = process.argv[b + 1];
    const bf = nextDir ? bundleAddresses(nextDir, config.state === "set" ? config.address : null) : ["--build needs a directory"];
    if (bf.length) {
      console.error("trust-config FAILED:\n- " + bf.join("\n- "));
      process.exit(1);
    }
    console.log(`trust-config: the build at ${nextDir} contains only allowed addresses.`);
  }
  const vo = process.argv.indexOf("--vercel-output");
  if (vo > 0) {
    const outDir = process.argv[vo + 1];
    const vf = outDir ? scanTree(outDir, config.state === "set" ? config.address : null) : ["--vercel-output needs a directory"];
    if (vf.length) {
      console.error("trust-config FAILED:\n- " + vf.join("\n- "));
      process.exit(1);
    }
    const dg = artifactDigest(outDir!);
    console.log(`trust-config: the artifact at ${outDir} (${dg.files} files, sha256 ${dg.sha256}) contains only allowed addresses.`);
    const rec = process.argv.indexOf("--record");
    if (rec > 0) {
      const file = process.argv[rec + 1];
      if (!file) throw new Error("--record needs a file");
      const commit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      // untracked files count: vercel build would include an untracked page that is in no commit
      const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).trim();
      if (dirty) throw new Error(`the working tree has uncommitted or untracked files; a release is built from a commit:\n${dirty}`);
      writeRecord(resolve(ROOT, file), dg, commit, config.state === "set" ? config.address : null);
      console.log(`trust-config: release record written to ${file}`);
    }
  }
  if (config.state === "null") {
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
