/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts) rule 2: "since [the receipt's commit] the ONLY
 * files changed are config.ts, the receipt and Markdown notes (no code, build config or dependency)".
 *
 * changedSince() lists paths with `git diff --name-only`, which detects renames by default and prints only the new
 * name. Renaming a file to *.md therefore reports one allowed Markdown path and hides that the original file is gone.
 * The example is app/pnpm-lock.yaml: without it the app's dependencies are no longer pinned (package.json uses
 * caret ranges), and the trust-config job installs only the root lockfile, so the job stays green.
 *
 * The git history is constructed here in a temporary repository holding a copy of ops/trust-config.ts (its ROOT
 * is the directory above ops/), with the real app/pnpm-lock.yaml as the renamed file.
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

  it("deleting app/pnpm-lock.yaml after the deployed commit is reported as a non-allowed change", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-rename-"));
    mkdirSync(join(repo, "ops"));
    mkdirSync(join(repo, "app"));
    cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
    cpSync(join(ROOT, "app/pnpm-lock.yaml"), join(repo, "app/pnpm-lock.yaml"));
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", "ops", "app");
    git("commit", "-qm", "stands in for the reviewed, deployed commit");
    const deployed = git("rev-parse", "HEAD").trim();
    git("mv", "app/pnpm-lock.yaml", "app/pnpm-lock.md");
    git("commit", "-qm", "config commit");
    assert.deepEqual(git("ls-files", "app").trim().split("\n"), ["app/pnpm-lock.md"], "the lockfile is gone at HEAD");

    const gate = (await import(pathToFileURL(join(repo, "ops/trust-config.ts")).href)) as typeof import("../ops/trust-config.ts");
    const changed = gate.changedSince(deployed);
    assert.ok(changed, "the deployed commit is an ancestor of HEAD");
    const refused = changed.filter((p) => !gate.CONFIG_COMMIT_ALLOWS(p));
    assert.ok(
      refused.includes("app/pnpm-lock.yaml"),
      `rule 2 saw only ${JSON.stringify(changed)}; the deleted lockfile passed as a Markdown note`,
    );
  });
});
