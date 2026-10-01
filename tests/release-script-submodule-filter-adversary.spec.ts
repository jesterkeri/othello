/**
 * Adversary test on 4570ded (requirement: no program named by configuration, the caller's or the repository's own
 * fsmonitor, hooks, filter/diff/merge drivers, may run in any git call of the release path, from its first call).
 *
 * The fix refuses a repository whose own config names a filter, diff or merge driver, read with `git config
 * --get-regexp` in the superproject (ops/release-robinhood.sh, ops/trust-config.ts gitProgramDrivers). But this
 * repository has submodules (evm/lib/forge-std, evm/lib/openzeppelin-contracts), and an initialized submodule keeps its
 * own config in the superproject's .git/modules/<path>/config, which that read never sees. `git status` in the
 * superproject runs `git status` inside every initialized submodule to tell whether it is dirty, and that child reads
 * the submodule's config: a `filter.<name>.clean` there, selected by the submodule's info/attributes, runs on any file
 * whose stat data no longer matches the submodule's index. The -c overrides of safe_git reach the child, but no -c
 * switch turns a driver off, and the driver check never looked there. So the release's first `status` runs it.
 *
 * The submodule is the repository's real evm/lib/forge-std at its committed commit, so the checkout reads as clean (as
 * the operator's own checkout does once `forge build` needed the libraries). It is fetched from a local copy under this
 * repository's git directory when one exists (read only), otherwise from the URL in .gitmodules. The planted clean
 * filter passes the bytes through unchanged (`cat`), and only appends a line to a file in the test's temporary folder.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-submodule-filter-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUB = "evm/lib/forge-std";

/** A local repository that already holds forge-std's objects (an initialized module of any worktree), else the URL. */
function forgeStdSource(): string {
  const common = resolve(ROOT, execFileSync("git", ["-C", ROOT, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
  const candidates = [join(common, "modules", SUB)];
  const wt = join(common, "worktrees");
  if (existsSync(wt)) for (const w of readdirSync(wt)) candidates.push(join(wt, w, "modules", SUB));
  const pinned = execFileSync("git", ["-C", ROOT, "rev-parse", `HEAD:${SUB}`], { encoding: "utf8" }).trim();
  for (const c of candidates) {
    if (spawnSync("git", ["--git-dir", c, "cat-file", "-e", `${pinned}^{commit}`]).status === 0) return c;
  }
  return execFileSync("git", ["-C", ROOT, "config", "-f", ".gitmodules", `submodule.${SUB}.url`], { encoding: "utf8" }).trim();
}

describe("release: no filter driver named by a submodule's config runs (adversary on 4570ded)", function () {
  this.timeout(900_000);

  it("a filter.<name>.clean in an initialized submodule's own config never runs during the release", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-submodule-filter-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    // the operator's state: the library submodule initialized at the committed commit
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("submodule", "init", SUB);
    git("config", `submodule.${SUB}.url`, forgeStdSource());
    git("-c", "protocol.file.allow=always", "submodule", "update", "--quiet", SUB);
    const modDir = join(repo, ".git", "modules", SUB);
    assert.ok(existsSync(join(modDir, "config")), "precondition: the submodule's git directory is under the superproject's .git/modules");

    const ran = join(tmp, "SUBMODULE-FILTER-RAN");
    const filter = join(tmp, "clean-filter.sh");
    writeFileSync(filter, `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(ran)}\nexec cat\n`);
    chmodSync(filter, 0o755);
    execFileSync("git", ["--git-dir", modDir, "config", "filter.adv.clean", `${filter} %f`]);
    mkdirSync(join(modDir, "info"), { recursive: true });
    writeFileSync(join(modDir, "info", "attributes"), "README.md filter=adv\n");
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);

    // the release's own driver check, as the script runs it, finds nothing in the superproject
    const sealed = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const check = spawnSync("git", ["-C", repo, "config", "--get-regexp",
      "^(filter\\..+\\.(clean|smudge|process)|diff\\..+\\.(textconv|command)|merge\\..+\\.driver|diff\\.external)$"], { env: sealed, encoding: "utf8" });
    assert.equal(check.stdout, "", "precondition: the superproject's config names no driver, so the release's check passes");

    // not vacuous: with the submodule README's stat data changed (content unchanged), the release's own first status
    // (safe_git's switches, no system or global config) runs the planted filter and still reads the checkout as clean
    const touch = (ahead: number) => { const t = new Date(Date.now() + ahead); utimesSync(join(repo, SUB, "README.md"), t, t); };
    const safeStatus = () => execFileSync("git", ["-C", repo, "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null",
      "status", "--porcelain", "--untracked-files=all"], { env: sealed, encoding: "utf8" });
    touch(5_000);
    assert.equal(safeStatus(), "", "precondition: the checkout reads as clean");
    assert.ok(existsSync(ran), "precondition: the release's first status runs the submodule's planted clean filter");
    rmSync(ran);
    touch(60_000); // stat data changed again, as after any checkout or editor save in the library

    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-10).join("\n");
    assert.equal(existsSync(ran), false,
      `the release ran the program named by a submodule's filter config:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}(release exit ${r.status}, deployed ${existsSync(uploaded)})\n${tail}`);
  });
});
