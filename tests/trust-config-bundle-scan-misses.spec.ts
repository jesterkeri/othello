/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts), ARB-DESIGN r9 sections A, 7.1 and 9.1: the built
 * Robinhood page may approve only the real USDG and trust or write to only the factory in config.ts. The build scan
 * (`--build app/.next`, F-12) states: "However an import is routed, a hard-coded factory has to be in the bytes the
 * browser receives", and every 20-byte address in those bytes must be USDG, zero, viem's placeholder or the
 * trusted factory. Its stated limit is only "an address assembled at run time from pieces".
 *
 * Two ordinary, whole, hard-coded addresses the browser receives and the gate never sees:
 *   1. a pre-encoded ERC-20 `approve(spender, max)` calldata literal sent to the real USDG (as `cast calldata`
 *      prints it). The spender is written out in full, lowercase hex, inside one string literal; the scan only
 *      matches an address with `0x` right before it, so an address inside ABI-encoded bytes is invisible;
 *   2. a JSON file in app/public, served beside the bundle, that the page fetches for the token to approve. The
 *      scan reads .next/static and .next/server only, and appTreeRules skips public/.
 * The test copies the real app (pinned next.config.mjs and tsconfig.json), adds one client page and one public
 * file, runs the real `next build`, then runs the gate exactly as CI does.
 *
 * Inputs are constructed here: the two addresses are derived from labels, not from any deployment.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, keccak256, toHex } from "viem";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const label = (s: string) => getAddress(`0x${keccak256(toHex(s)).slice(26)}`);
/** The spender the calldata literal approves: an unreviewed factory. */
const SPENDER = label("unreviewed spender in calldata");
/** The token the public JSON names: not USDG. */
const FOREIGN_TOKEN = label("unreviewed token in public json");

const APPROVE_MAX = `0x095ea7b3${"0".repeat(24)}${SPENDER.slice(2).toLowerCase()}${"f".repeat(64)}`;

/** A client page that approves with a pre-encoded call and with a token read from a public JSON file. */
const PAGE = [
  '"use client";',
  'import { createWalletClient, custom, erc20Abi, type Address } from "viem";',
  'import { USDG, robinhoodTestnet } from "@/lib/robinhood/chain";',
  "",
  "/** approve(spender, max), as `cast calldata` prints it. */",
  `const APPROVE_MAX = "${APPROVE_MAX}";`,
  "",
  "export default function Page() {",
  "  async function go() {",
  "    const w = createWalletClient({ chain: robinhoodTestnet, transport: custom((window as never as { ethereum: never }).ethereum) });",
  "    const [account] = await w.requestAddresses();",
  "    await w.sendTransaction({ account: account!, to: USDG, data: APPROVE_MAX });",
  '    const cfg = (await (await fetch("/rh-token.json")).json()) as { token: Address };',
  '    await w.writeContract({ account: account!, address: cfg.token, abi: erc20Abi, functionName: "approve", args: [account!, 1n] });',
  "  }",
  "  return <button onClick={go}>Approve</button>;",
  "}",
  "",
].join("\n");

const walk = (d: string, out: string[] = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

describe("trust-config adversary: hard-coded addresses the build scan does not read", function () {
  this.timeout(900_000);

  let tree = "";
  let gate: import("node:child_process").SpawnSyncReturns<string>;

  before(() => {
    tree = mkdtempSync(join(tmpdir(), "trust-config-scan-"));
    mkdirSync(join(tree, "ops"));
    mkdirSync(join(tree, "app"));
    cpSync(join(ROOT, "ops/trust-config.ts"), join(tree, "ops/trust-config.ts"));
    cpSync(join(ROOT, "app/src"), join(tree, "app/src"), { recursive: true });
    for (const f of ["package.json", "next.config.mjs", "tsconfig.json"]) cpSync(join(ROOT, "app", f), join(tree, "app", f));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    symlinkSync(join(ROOT, "app/node_modules"), join(tree, "app/node_modules"));
    mkdirSync(join(tree, "app/src/app/rh-approve"));
    writeFileSync(join(tree, "app/src/app/rh-approve/page.tsx"), PAGE);
    mkdirSync(join(tree, "app/public"));
    writeFileSync(join(tree, "app/public/rh-token.json"), JSON.stringify({ token: FOREIGN_TOKEN }));

    const build = spawnSync(process.execPath, [join(tree, "app/node_modules/next/dist/bin/next"), "build"], {
      cwd: join(tree, "app"),
      encoding: "utf8",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    assert.equal(build.status, 0, `next build failed:\n${build.stdout}${build.stderr}`);

    // The gate, as CI runs it (config null, so no RPC call is made).
    gate = spawnSync(process.execPath, ["--import", "tsx", "ops/trust-config.ts", "--rpc", "http://127.0.0.1:9", "--build", "app/.next"], {
      cwd: tree,
      encoding: "utf8",
    });
  });

  it("an unreviewed spender inside a hard-coded approve calldata literal fails the gate", () => {
    // It is in the bytes the browser receives, whole and in plain hex.
    const chunks = walk(join(tree, "app/.next/static")).filter((p) => p.endsWith(".js"));
    assert.ok(
      chunks.some((p) => readFileSync(p, "utf8").includes(SPENDER.slice(2).toLowerCase())),
      "the spender is in the client bundle",
    );
    assert.notEqual(gate.status, 0, `gate passed while the page approves USDG for ${SPENDER}:\n${gate.stdout}${gate.stderr}`);
    assert.match(`${gate.stderr}`, new RegExp(SPENDER.slice(2), "i"));
  });

  it("an unreviewed token in a public JSON file the page fetches fails the gate", () => {
    // It is served with the deployment (Next copies public/ to the site root), whole and 0x-prefixed.
    assert.match(readFileSync(join(tree, "app/public/rh-token.json"), "utf8"), new RegExp(FOREIGN_TOKEN));
    assert.notEqual(gate.status, 0, `gate passed while the page approves token ${FOREIGN_TOKEN}:\n${gate.stdout}${gate.stderr}`);
    assert.match(`${gate.stderr}`, new RegExp(FOREIGN_TOKEN.slice(2), "i"));
  });
});
