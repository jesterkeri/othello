/**
 * Adversary test on 12f1cb7 (requirement 2: no program named by any configuration, the repository's included, runs in
 * any git call of the release path).
 *
 * 12f1cb7 adds `safe_git ls-tree -r HEAD` to the clean-checkout check. That call reads every tree of HEAD. In a
 * repository with a promisor remote (a partial clone: `extensions.partialClone`, `remote.<name>.promisor`), git 2.43
 * fetches any object it is missing from that remote on demand, and the fetch starts the upload-pack program the
 * repository's own config names (`remote.<name>.uploadpack`). No -c switch of safe_git turns this off, and the
 * repository-config driver check does not look at remote settings.
 *
 * The plain status the release ran before 12f1cb7 does not need the missing tree (the index's cache-tree answers for
 * it), so the program does not run on status alone: this is the new ls-tree call's doing. The fetched tree is the
 * genuine one, so the release then goes on and deploys.
 *
 * The repositories are made here with git itself; the "program" only appends its arguments to a sentinel file and
 * then runs the real `git upload-pack`. Nothing outside the test's temporary folder is written.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-lazy-fetch-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release: a promisor remote's upload-pack runs during the clean-checkout check (adversary on 12f1cb7)", function () {
  this.timeout(900_000);

  it("the release's git calls start no program named by the repository's config, partial clone or not", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-lazy-fetch-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    const head = commitTestReleaseTarget(repo);

    // the promisor remote holds every object of HEAD; the checkout lacks one tree of it (the new `ops` tree, written
    // loose by the commit above), as a partial clone lacks what it has not needed yet
    const promisor = join(tmp, "promisor.git");
    execFileSync("git", ["clone", "--quiet", "--bare", "--no-local", repo, promisor]);
    const opsTree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD:ops"], { encoding: "utf8" }).trim();
    const loose = join(repo, ".git", "objects", opsTree.slice(0, 2), opsTree.slice(2));
    assert.ok(existsSync(loose), "precondition: HEAD's ops tree is a loose object of the checkout");
    rmSync(loose);

    // the repository's own config: a promisor remote, and the upload-pack program a fetch from it starts
    const sentinel = join(tmp, "SENTINEL");
    const program = join(tmp, "upload-pack.sh");
    writeFileSync(program, `#!/bin/sh\necho "$@" >> ${JSON.stringify(sentinel)}\nexec git upload-pack "$@"\n`);
    chmodSync(program, 0o755);
    const config = (k: string, v: string) => execFileSync("git", ["-C", repo, "config", k, v]);
    config("remote.origin.url", promisor);
    config("remote.origin.promisor", "true");
    config("extensions.partialClone", "origin");
    config("remote.origin.uploadpack", program);

    // not vacuous: the release's own status (safe_git's switches, no system or global config) calls the checkout clean
    // and starts nothing; the tree is still missing afterwards
    const sealed = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const safe = ["-C", repo, "--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null"];
    const status = spawnSync("git", [...safe, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], { env: sealed, encoding: "utf8" });
    assert.equal(status.status, 0, `precondition: the release's status succeeds:\n${status.stderr}`);
    assert.equal(status.stdout, "", "precondition: the release's status calls the checkout clean");
    assert.equal(existsSync(sentinel), false, "precondition: the release's status starts no program");
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-8).join("\n");
    assert.equal(existsSync(sentinel), false,
      `the release started ${program}, named by the repository's remote.origin.uploadpack (release exit ${r.status}, deployed: ${existsSync(uploaded)}):\n${tail}`);
  });
});
