/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts) rule 2: since the receipt's commit nothing in the
 * contract bundle may change, evm/lib/ (the contracts' pinned libraries, gitlinks) included (CONTRACT_BUNDLE;
 * ARB-DESIGN r11 §8).
 *
 * changedSince() runs `git diff --no-renames --name-only -z <commit> HEAD` through gitIn. gitIn pins many repository
 * settings on the command line but not `diff.ignoreSubmodules` nor `submodule.<name>.ignore`, and `git diff` is a
 * porcelain that honours both, also for a tree-to-tree diff: with either set to `all` in the repository's own
 * .git/config, a gitlink moved to other library code since the deploy is not listed at all, so the bump passes rule 2.
 *
 * The git history is constructed here in a temporary repository holding a copy of ops/trust-config.ts (its ROOT
 * is the directory above ops/), as in trust-config-quoted-path-adversary.spec.ts. The gitlink object ids are
 * constructed (no submodule repository is needed: a tree diff never opens one).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIB = "evm/lib/forge-std";

describe("trust-config adversary: a repository setting hides an evm/lib gitlink bump (ops/trust-config.ts rule 2)", function () {
  this.timeout(60_000);

  for (const [key, value] of [["diff.ignoreSubmodules", "all"], [`submodule.${LIB}.ignore`, "all"]] as const) {
    it(`with ${key}=${value} in .git/config, a gitlink bump under evm/lib/ after the deploy is still reported`, async () => {
      const repo = mkdtempSync(join(tmpdir(), "trust-config-gitlink-"));
      mkdirSync(join(repo, "ops"));
      mkdirSync(join(repo, "evm/lib"), { recursive: true });
      cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
      cpSync(join(ROOT, "evm/foundry.toml"), join(repo, "evm/foundry.toml"));
      symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
      const git = (...a: string[]) =>
        execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
      cpSync(join(ROOT, ".gitmodules"), join(repo, ".gitmodules")); // names the submodule at evm/lib/forge-std, as committed
      git("init", "-q");
      git("add", "ops", "evm", ".gitmodules");
      git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},${LIB}`);
      git("commit", "-qm", "stands in for the reviewed, deployed commit");
      const deployed = git("rev-parse", "HEAD").trim();
      git("update-index", "--cacheinfo", `160000,${"2".repeat(40)},${LIB}`);
      git("commit", "-qm", "after the deploy: the library points at other code");
      assert.equal(git("diff", "--no-renames", "--name-only", deployed, "HEAD").trim(), LIB, "precondition: git lists the bump");

      git("config", key, value);

      const gate = (await import(pathToFileURL(join(repo, "ops/trust-config.ts")).href)) as typeof import("../ops/trust-config.ts");
      const changed = gate.changedSince(deployed);
      assert.ok(changed, "the deployed commit is an ancestor of HEAD");
      assert.deepEqual(changed.filter(gate.CONTRACT_BUNDLE), [LIB], `rule 2 saw ${JSON.stringify(changed)}: the evm/lib gitlink bump passed`);
    });
  }
});
