/**
 * Adversary probe for CI job `trust-config` (ops/trust-config.ts) rule 2 on dec7f58: changedSince() must "never fail
 * for the real, correct state", including "a developer's checkout that is a linked worktree of a repository with many
 * other worktrees" (adversary brief for dec7f58).
 *
 * changedSince() now runs `git fsck` first. fsck reads the index of EVERY worktree of the repository, and git 2.43
 * reports "missing tree 4b825dc6..." (the empty tree, which git never writes as an object) for an index whose
 * cache-tree is the empty tree. `git worktree add --orphan` (and `git switch --orphan`, `git read-tree --empty`) leaves
 * exactly that index in a sibling worktree, so fsck exits 2 and the gate calls the reviewed deployed commit
 * "not an ancestor of HEAD" in every other worktree, though no object is missing or forged.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: an orphan sibling worktree fails fsck (ops/trust-config.ts changedSince)", function () {
  this.timeout(60_000);

  it("a linked worktree still sees the deployed commit as an unchanged ancestor when a sibling worktree is on a new orphan branch", async () => {
    const base = mkdtempSync(join(tmpdir(), "trust-config-orphan-wt-"));
    const repo = join(base, "main");
    mkdirSync(join(repo, "ops"), { recursive: true });
    mkdirSync(join(repo, "core/actions"), { recursive: true });
    cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", ["-C", cwd, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
    git(repo, "init", "-q");
    writeFileSync(join(repo, "core/actions/standard.json"), '{"rounds": 10}\n');
    git(repo, "add", "ops", "core");
    git(repo, "commit", "-qm", "stands in for the reviewed, deployed commit");
    const deployed = git(repo, "rev-parse", "HEAD").trim();
    const gateFile = join(repo, "ops/trust-config.ts");
    writeFileSync(gateFile, readFileSync(gateFile, "utf8").replace(/^export const DEPLOYED_COMMIT = "[0-9a-f]{40}";$/m,
      `export const DEPLOYED_COMMIT = "${deployed}";`));
    writeFileSync(join(repo, "README.md"), "page-bundle only\n");
    git(repo, "add", "ops", "README.md");
    git(repo, "commit", "-qm", "after the deploy: pin the deployed commit, page bundle only");

    // the developer's checkout: a linked worktree of that repository
    const dev = join(base, "dev");
    git(repo, "worktree", "add", "-q", "--detach", dev, "HEAD");
    symlinkSync(join(ROOT, "node_modules"), join(dev, "node_modules"));
    // another worktree of the same repository starts a new branch with no history (a docs or gh-pages branch)
    git(repo, "worktree", "add", "-q", "--orphan", "-b", "pages", join(base, "pages"));

    const gate = (await import(pathToFileURL(join(dev, "ops/trust-config.ts")).href)) as typeof import("../ops/trust-config.ts");
    const changed = gate.changedSince(gate.DEPLOYED_COMMIT);
    assert.ok(changed !== null, "rule 2 called the reviewed deployed commit not an ancestor of HEAD because a sibling worktree is on an orphan branch");
    assert.deepEqual(changed.filter(gate.CONTRACT_BUNDLE), []);
  });
});
