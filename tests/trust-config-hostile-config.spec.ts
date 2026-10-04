/**
 * Adversary tests for CI job `trust-config` (ops/trust-config.ts), ARB-DESIGN r9 sections 7.1 and 9.1:
 * the gate must fail closed, so a config.ts whose exported TRUSTED_FACTORY is set must never be read as null.
 * Inputs are constructed here: the address and hash below are derived from labels, not from any deployment,
 * because the point is that the gate never looks at them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAddress, keccak256, toHex } from "viem";

import { PATHS, loadConfig } from "../ops/trust-config.ts";
import { replaceTrustedFactory } from "./config-fixture.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UNREVIEWED = getAddress(`0x${keccak256(toHex("not the reviewed factory")).slice(26)}`);
const UNREVIEWED_HASH = keccak256(toHex("not the reviewed runtime"));

/** The committed config.ts with the null line kept as a comment, and the canonical set assignment below it. */
const hostile = () =>
  replaceTrustedFactory(
    readFileSync(PATHS.config, "utf8"),
    [
      "// Before the deploy this read:",
      "// export const TRUSTED_FACTORY: TrustedFactory | null = null;",
      `export const TRUSTED_FACTORY: TrustedFactory | null = { address: "${UNREVIEWED}", codeHash: "${UNREVIEWED_HASH}" };`,
    ].join("\n"),
  );

/** Adversary regression (2026-09-28): the gate once parsed config.ts as text and read a commented line. */
describe("trust-config adversary (ops/trust-config.ts)", function () {
  this.timeout(60_000);

  it("the hostile config is real TypeScript whose exported TRUSTED_FACTORY is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-config-adv-"));
    const file = join(dir, "config.ts");
    writeFileSync(file, hostile());
    const mod = (await import(pathToFileURL(file).href)) as { TRUSTED_FACTORY: { address: string; codeHash: string } | null };
    assert.deepEqual(mod.TRUSTED_FACTORY, { address: UNREVIEWED, codeHash: UNREVIEWED_HASH });
  });

  it("the gate does not read a set TRUSTED_FACTORY as null because the old null line survives in a comment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-config-adv-"));
    writeFileSync(join(dir, "config.ts"), hostile());
    assert.notEqual((await loadConfig(join(dir, "config.ts"))).state, "null");
  });

  it("the gate never reports a set address other than the one the file exports", async () => {
    const REVIEWED = getAddress(`0x${keccak256(toHex("stands in for the reviewed factory")).slice(26)}`);
    const src = replaceTrustedFactory(
      readFileSync(PATHS.config, "utf8"),
      [
        `/* export const TRUSTED_FACTORY: TrustedFactory | null = { address: "${REVIEWED}", codeHash: "${UNREVIEWED_HASH}" }; */`,
        `export const TRUSTED_FACTORY: TrustedFactory | null = { address: "${UNREVIEWED}", codeHash: "${UNREVIEWED_HASH}" } as TrustedFactory;`,
      ].join("\n"),
    );
    const dir = mkdtempSync(join(tmpdir(), "trust-config-adv-"));
    writeFileSync(join(dir, "config.ts"), src);
    const mod = (await import(pathToFileURL(join(dir, "config.ts")).href)) as { TRUSTED_FACTORY: { address: string } };
    assert.equal(mod.TRUSTED_FACTORY.address, UNREVIEWED);
    const parsed = await loadConfig(join(dir, "config.ts"));
    if (parsed.state === "set") assert.equal(parsed.address, UNREVIEWED, "the gate verifies a different address than the page trusts");
  });

  it("the CLI exits non-zero when the page would trust an unreviewed factory", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-config-cli-"));
    mkdirSync(join(dir, "ops"));
    mkdirSync(join(dir, "app/src/lib/robinhood"), { recursive: true });
    copyFileSync(join(ROOT, "ops/trust-config.ts"), join(dir, "ops/trust-config.ts"));
    writeFileSync(join(dir, "app/src/lib/robinhood/config.ts"), hostile());
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    // No receipt, no artifact, no git history, an RPC that does not exist: every check must fail.
    const run = spawnSync(process.execPath, ["--import", "tsx", "ops/trust-config.ts", "--rpc", "http://127.0.0.1:9"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0, `gate passed:\n${run.stdout}${run.stderr}`);
  });
});
