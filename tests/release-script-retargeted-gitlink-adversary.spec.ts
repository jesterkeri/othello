/**
 * Adversary test on d39ec27 (requirement: the clean-checkout check must still refuse a checkout whose build input
 * differs from HEAD, anything in app/ or at the repository root, including a staged, removed, retargeted or
 * type-changed gitlink there).
 *
 * d39ec27 runs the clean-checkout status with `--ignore-submodules=dirty`. In that mode git still asks whether each
 * submodule's checked-out commit is the one the gitlink pins, and to answer it opens the submodule as a repository with
 * that submodule's OWN config (git 2.43 resolve_gitlink_ref -> repo_submodule_init reads its repository format). When
 * that open fails, git treats the gitlink as unchanged instead of failing. A submodule whose config names a repository
 * extension this git does not know (as a newer git writes one) therefore reads as clean, whatever commit it has checked
 * out: the plain status (submodules not ignored) stops with a fatal error, the release's status prints nothing.
 *
 * So a gitlink at the repository root, retargeted to a commit that is not the pinned one, passes the check, and the
 * release builds and deploys. Before the extension is added, the same retarget is refused (` M extra`), so the test is
 * about the submodule's own config deciding what the check sees, not about the retarget alone.
 *
 * The nested repository is made here with git itself; nothing outside the test's temporary folder is written.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-retargeted-gitlink-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NESTED = "extra";

describe("release: a retargeted gitlink at the root is an uncommitted change (adversary on d39ec27)", function () {
  this.timeout(900_000);

  it("the clean-checkout check refuses a root gitlink checked out at another commit, whatever the submodule's config says", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-retargeted-gitlink-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    // the commit carries a gitlink at the repository root
    const ident = ["-c", "user.name=t", "-c", "user.email=t@t.invalid"];
    const nested = join(repo, NESTED);
    mkdirSync(nested);
    writeFileSync(join(nested, "pinned.txt"), "the pinned commit\n");
    execFileSync("git", ["-C", nested, "init", "-q"]);
    execFileSync("git", ["-C", nested, "add", "pinned.txt"]);
    execFileSync("git", ["-C", nested, ...ident, "commit", "-q", "-m", "pinned"]);
    execFileSync("git", ["-C", repo, "add", NESTED], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-C", repo, ...ident, "commit", "-q", "-m", "test: a gitlink at the root"]);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const pinned = execFileSync("git", ["-C", repo, "rev-parse", `HEAD:${NESTED}`], { encoding: "utf8" }).trim();

    // the operator's change: the nested repository is moved to another commit (not staged)
    writeFileSync(join(nested, "pinned.txt"), "not the pinned commit\n");
    execFileSync("git", ["-C", nested, ...ident, "commit", "-q", "-am", "retargeted"]);
    const moved = execFileSync("git", ["-C", nested, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.notEqual(moved, pinned);

    // not vacuous: the release's own status (safe_git's switches, no system or global config) reports the retarget
    const sealed = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const safeStatus = () => spawnSync("git", ["-C", repo, "--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null",
      "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], { env: sealed, encoding: "utf8" }).stdout;
    assert.match(safeStatus(), new RegExp(`^ M ${NESTED}$`, "m"), "precondition: the check sees the retarget while the submodule's config is plain");

    // the submodule's own config names a repository extension git 2.43 does not know; nothing else changes
    execFileSync("git", ["-C", nested, "config", "core.repositoryformatversion", "1"]);
    execFileSync("git", ["-C", nested, "config", "extensions.unknownToThisGit", "true"]);
    const branch = /^ref: (refs\/heads\/\S+)$/.exec(readFileSync(join(nested, ".git", "HEAD"), "utf8").trim())?.[1];
    assert.ok(branch, "precondition: the submodule is on a branch");
    assert.equal(readFileSync(join(nested, ".git", branch), "utf8").trim(), moved, "precondition: still checked out at the retargeted commit");
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
    const plain = spawnSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { env: sealed, encoding: "utf8" });
    assert.notEqual(plain.status, 0, `precondition: git's plain status cannot call this checkout clean:\n${plain.stdout}${plain.stderr}`);

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-8).join("\n");
    assert.equal(existsSync(uploaded), false,
      `the release deployed from a checkout whose root gitlink ${NESTED} is checked out at ${moved}, not the pinned ${pinned} (release exit ${r.status}; its own status now: ${JSON.stringify(safeStatus())}):\n${tail}`);
    assert.notEqual(r.status, 0, "the release refuses a checkout whose root gitlink is not at its pinned commit");
  });
});
