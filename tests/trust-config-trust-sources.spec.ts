/**
 * Adversary tests for CI job `trust-config` (ops/trust-config.ts), ARB-DESIGN r9 sections 7.1 and 9.1: the gate
 * must fail closed, and every place in app/src that trusts a factory must take it from config.ts, with the value
 * the gate verified being the value the running page trusts.
 * Inputs are constructed here: the addresses and hashes below are derived from labels, not from any deployment,
 * because the point is which value the gate looks at, not whether that value is on chain.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAddress, keccak256, toHex } from "viem";

import { importBoundary, loadConfig } from "../ops/trust-config.ts";
import { checkTrusted } from "../app/src/lib/robinhood/adapter.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REVIEWED = getAddress(`0x${keccak256(toHex("stands in for the reviewed factory")).slice(26)}`);
const REVIEWED_HASH = keccak256(toHex("stands in for the reviewed runtime"));
const UNREVIEWED = getAddress(`0x${keccak256(toHex("not the reviewed factory")).slice(26)}`);
const UNREVIEWED_HASH = keccak256(toHex("not the reviewed runtime"));

/**
 * A page helper that trusts a hard-coded factory through a trust function imported under another name.
 * Adversary regression (2026-09-28). Since the fix, the app's checkTrusted takes no factory (see the last case),
 * so the only function that accepts one is the core's checkTrustedAgainst; the attack is re-aimed at it.
 */
const ALIASED_TRUST = [
  'import { checkTrustedAgainst as isOthelloCircle } from "@/lib/robinhood/adapter-core";',
  'import { robinhoodPublicClient } from "@/lib/robinhood/wallet";',
  "",
  `const FACTORY = { address: "${UNREVIEWED}", codeHash: "${UNREVIEWED_HASH}" } as const;`,
  "",
  "export const trustCircle = (circle: `0x${string}`) => isOthelloCircle(robinhoodPublicClient, circle, FACTORY);",
  "",
].join("\n");

/** A config whose exported value depends on where it runs: Node (the gate) sees one factory, the browser another. */
const ENV_DEPENDENT_CONFIG = [
  'import type { Address, Hex } from "viem";',
  "",
  "export type TrustedFactory = { address: Address; codeHash: Hex };",
  "",
  `const A: TrustedFactory = { address: "${REVIEWED}", codeHash: "${REVIEWED_HASH}" };`,
  `const B: TrustedFactory = { address: "${UNREVIEWED}", codeHash: "${UNREVIEWED_HASH}" };`,
  "",
  'export const TRUSTED_FACTORY: TrustedFactory | null = typeof window === "undefined" ? A : B;',
  "",
].join("\n");

describe("trust-config adversary: where the page's factory really comes from (ops/trust-config.ts)", function () {
  this.timeout(60_000);

  it("a checkTrusted call under an import alias, with a hard-coded factory, is caught as a second source of trust", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-src-alias-"));
    cpSync(join(ROOT, "app/src"), dir, { recursive: true });
    writeFileSync(join(dir, "components/robinhood/trust.ts"), ALIASED_TRUST);
    assert.notDeepEqual(importBoundary(dir), [], "the page trusts a factory that is not TRUSTED_FACTORY");
  });

  it("the CLI does not pass with a null config while the page trusts a hard-coded factory", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-config-alias-cli-"));
    mkdirSync(join(dir, "ops"));
    mkdirSync(join(dir, "app"));
    copyTree(dir);
    writeFileSync(join(dir, "app/src/components/robinhood/trust.ts"), ALIASED_TRUST);
    const run = spawnSync(process.execPath, ["--import", "tsx", "ops/trust-config.ts", "--rpc", "http://127.0.0.1:9"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0, `gate passed:\n${run.stdout}${run.stderr}`);
  });

  it("the address the gate verifies is the address the page trusts in the browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-config-env-"));
    const file = join(dir, "config.ts");
    // app/package.json declares "type": "module", so config.ts loads as ES module there; mirror that here.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(file, ENV_DEPENDENT_CONFIG);
    const gate = await loadConfig(file);
    const g = globalThis as { window?: unknown };
    g.window = {};
    let page: { address: string } | null;
    try {
      page = ((await import(`${pathToFileURL(file).href}?t=browser`)) as { TRUSTED_FACTORY: { address: string } | null }).TRUSTED_FACTORY;
    } finally {
      delete g.window;
    }
    assert.equal(page?.address, UNREVIEWED, "the browser evaluation sees the other factory");
    if (gate.state === "set") assert.equal(gate.address, page?.address, "the gate verifies a different address than the page trusts");
  });

  it("the app's checkTrusted ignores any factory passed to it and uses TRUSTED_FACTORY (null: not deployed)", async () => {
    const client = {
      getCode: async () => "0x6000" as const,
      readContract: async () => { throw new Error("must not read: the trusted factory is null"); },
    };
    const call = checkTrusted as unknown as (...a: unknown[]) => Promise<unknown>;
    assert.deepEqual(await call(client, UNREVIEWED, { address: UNREVIEWED, codeHash: UNREVIEWED_HASH }), { ok: false, reason: "not-deployed" });
  });
});

function copyTree(dir: string) {
  cpSync(join(ROOT, "ops/trust-config.ts"), join(dir, "ops/trust-config.ts"));
  cpSync(join(ROOT, "app/src"), join(dir, "app/src"), { recursive: true });
  cpSync(join(ROOT, "app/package.json"), join(dir, "app/package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
}
