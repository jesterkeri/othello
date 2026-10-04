/**
 * Adversary test on a76e46a (requirement 1: no program named by any configuration, the repository's included, runs in
 * any git call of the release path).
 *
 * The refused-config pattern (ops/release-robinhood.sh `drivers=`, ops/trust-config.ts GIT_PROGRAM_DRIVERS) names a
 * driver's keys as `filter\..+\.(clean|smudge|process)` (and `remote\..+\.…`, `diff\..+\.…`, `merge\..+\.…`): `.+`
 * needs at least one character of subsection. git also accepts an EMPTY subsection: `git config filter..clean <cmd>`
 * writes `[filter ""] clean = <cmd>`, and an attribute with an empty value (`README.md filter=` in
 * `.git/info/attributes`) selects that driver by its empty name. `git config --get-regexp` lists the key as
 * `filter..clean`, which the pattern does not match, so the check passes; then the release's first `git status`
 * re-hashes README.md (its stat data changed, its bytes did not) through the named program.
 *
 * The planted clean filter passes the bytes through unchanged (`cat`), so the checkout still reads as clean, and only
 * appends a line to a file in the test's temporary folder.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-empty-driver-name-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitIn, gitProgramDrivers } from "../ops/trust-config.ts";
import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A clone of this repository's HEAD set up as the release expects, with an empty-named clean filter planted. */
function plantedCheckout(prefix: string) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(tmp, "repo");
  execFileSync("git", ["clone", "--quiet", ROOT, repo]);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
  appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
  mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
  writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
  commitTestReleaseTarget(repo);

  const ran = join(tmp, "EMPTY-NAMED-FILTER-RAN");
  const filter = join(tmp, "clean-filter.sh");
  writeFileSync(filter, `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(ran)}\nexec cat\n`);
  chmodSync(filter, 0o755);
  // git's own config command writes the empty-named driver
  execFileSync("git", ["-C", repo, "config", "filter..clean", `${filter} %f`]);
  writeFileSync(join(repo, ".git", "info", "attributes"), "README.md filter=\n");
  const touch = (ahead: number) => { const t = new Date(Date.now() + ahead); utimesSync(join(repo, "README.md"), t, t); };
  return { tmp, repo, ran, touch };
}

describe("release: an empty-named driver in the repository's config runs (adversary on a76e46a)", function () {
  this.timeout(900_000);

  it("a repository filter..clean (empty driver name) never runs during the release", () => {
    const { tmp, repo, ran, touch } = plantedCheckout("release-empty-driver-");
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);

    // not vacuous: the key is in the repository's config under the name the check reads, and a plain status with the
    // release's own switches (no system or global config) runs it and still calls the checkout clean
    const sealed = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" };
    assert.match(execFileSync("git", ["-C", repo, "config", "--get-regexp", "^filter\\."], { env: sealed, encoding: "utf8" }), /^filter\.\.clean /,
      "precondition: git lists the planted key as filter..clean");
    touch(5_000);
    const safe = ["-C", repo, "--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null"];
    assert.equal(execFileSync("git", [...safe, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], { env: sealed, encoding: "utf8" }), "",
      "precondition: the checkout reads as clean");
    assert.ok(existsSync(ran), "precondition: the release's status runs the planted empty-named clean filter");
    rmSync(ran);
    touch(60_000); // stat data changed again, as after any editor save or checkout

    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-10).join("\n");
    assert.equal(existsSync(ran), false,
      `the release ran the program named by the repository's filter..clean:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}(release exit ${r.status}, deployed ${existsSync(uploaded)})\n${tail}`);
  });

  it("gitProgramDrivers names an empty-named driver, and gitIn refuses before git runs it", () => {
    const { repo, ran, touch } = plantedCheckout("trust-config-empty-driver-");
    touch(5_000);
    let refused = "";
    try { gitIn(repo, ["status", "--porcelain", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty"]); } catch (e) { refused = String(e); }
    assert.equal(existsSync(ran), false,
      `gitIn's status ran the program named by filter..clean (gitProgramDrivers: ${JSON.stringify(gitProgramDrivers(repo))}, refused: ${JSON.stringify(refused)})`);
    assert.deepEqual(gitProgramDrivers(repo), ["filter..clean"]);
  });
});
