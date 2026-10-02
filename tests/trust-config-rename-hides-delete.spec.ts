/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts) rule 2: since the receipt's commit nothing in the
 * contract bundle or what builds it may change (CONTRACT_BUNDLE; ARB-DESIGN r11 §8).
 *
 * changedSince() lists paths with `git diff --name-only`, which detects renames by default and prints only the new
 * name. Renaming a file out of the bundle would therefore report one allowed path and hide that the original file is
 * gone. The example is evm/foundry.toml (the compiler, optimizer and EVM version the deployed bytecode was built
 * with), moved to a Markdown note.
 *
 * The git history is constructed here in a temporary repository holding a copy of ops/trust-config.ts (its ROOT
 * is the directory above ops/), with the real evm/foundry.toml as the renamed file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: a rename to *.md hides a deleted file (ops/trust-config.ts rule 2)", function () {
  this.timeout(60_000);

  it("moving evm/foundry.toml out of the bundle after the deployed commit is reported as a contract bundle change", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-rename-"));
    mkdirSync(join(repo, "ops"));
    mkdirSync(join(repo, "evm"));
    cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
    cpSync(join(ROOT, "evm/foundry.toml"), join(repo, "evm/foundry.toml"));
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", "ops", "evm");
    git("commit", "-qm", "stands in for the reviewed, deployed commit");
    const deployed = git("rev-parse", "HEAD").trim();
    git("mv", "evm/foundry.toml", "evm/foundry.md");
    git("commit", "-qm", "config commit");
    assert.deepEqual(git("ls-files", "evm").trim().split("\n"), ["evm/foundry.md"], "foundry.toml is gone at HEAD");

    const gate = (await import(pathToFileURL(join(repo, "ops/trust-config.ts")).href)) as typeof import("../ops/trust-config.ts");
    const changed = gate.changedSince(deployed);
    assert.ok(changed, "the deployed commit is an ancestor of HEAD");
    const refused = changed.filter(gate.CONTRACT_BUNDLE);
    assert.ok(
      refused.includes("evm/foundry.toml"),
      `rule 2 saw only ${JSON.stringify(changed)}; the deleted Foundry config passed as a Markdown note`,
    );
  });
});
