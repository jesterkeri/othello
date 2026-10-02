/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts) rule 2: since the receipt's commit nothing in the
 * contract bundle may change (CONTRACT_BUNDLE; ARB-DESIGN r11 §8).
 *
 * changedSince() accepts any 7 to 40 hex characters and hands them to `git merge-base` and `git diff` as a revision.
 * Foundry's receipt records the deploy commit abbreviated (evm/broadcast/DeployFactory.s.sol/46630/run-latest.json:
 * "commit": "3429255"), and git resolves an abbreviated name that is also a ref name to the REF, not the object: a
 * tag or branch named after the deployed commit's abbreviation, pointing at HEAD, turns the check into `git diff HEAD
 * HEAD`, which lists nothing. (A push of a branch so named is enough in CI: actions/checkout creates the local branch.)
 *
 * The git history is constructed here in a temporary repository holding a copy of ops/trust-config.ts (its ROOT
 * is the directory above ops/), as in trust-config-quoted-path-adversary.spec.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: a ref named like the deployed commit hides every change (ops/trust-config.ts rule 2)", function () {
  this.timeout(60_000);

  for (const ref of ["refs/tags", "refs/heads"]) {
    it(`with ${ref}/<abbreviated deployed commit> at HEAD, an evm/src change after the deploy is still reported`, async () => {
      const repo = mkdtempSync(join(tmpdir(), "trust-config-refname-"));
      mkdirSync(join(repo, "ops"));
      mkdirSync(join(repo, "evm/src"), { recursive: true });
      cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
      symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
      const git = (...a: string[]) =>
        execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
      git("init", "-q");
      writeFileSync(join(repo, "evm/src/Factory.sol"), "// reviewed\n");
      git("add", "ops", "evm");
      git("commit", "-qm", "stands in for the reviewed, deployed commit");
      const deployed = git("rev-parse", "--short=7", "HEAD").trim(); // as Foundry's receipt records it
      writeFileSync(join(repo, "evm/src/Factory.sol"), "// changed after the deploy\n");
      git("commit", "-qam", "after the deploy: the contract source changes");
      assert.equal(git("diff", "--name-only", deployed, "HEAD").trim(), "evm/src/Factory.sol", "precondition: git lists the change");

      git("update-ref", `${ref}/${deployed}`, "HEAD");

      const gate = (await import(pathToFileURL(join(repo, "ops/trust-config.ts")).href)) as typeof import("../ops/trust-config.ts");
      const changed = gate.changedSince(deployed);
      assert.ok(changed === null || changed.filter(gate.CONTRACT_BUNDLE).includes("evm/src/Factory.sol"),
        `rule 2 saw ${JSON.stringify(changed)}: the evm/src change passed`);
    });
  }
});
