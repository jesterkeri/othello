/**
 * Adversary test on cf03f94 (requirement 1: the refused-config check catches every key that names a program git can
 * start, for any driver or remote name git accepts, in both copies, and the two copies agree).
 *
 * ops/release-robinhood.sh asks `git config --get-regexp '^(filter\..*\.(clean|smudge|process)|…)$'`. git matches that
 * pattern with the C library's regex in the caller's locale, and the release keeps LANG and LC_ALL (ALLOWED_ENV). In a
 * UTF-8 locale (Ubuntu's default is LANG=C.UTF-8) `.` does not match a byte that is not valid UTF-8, so a driver whose
 * name is such a byte (`[filter "\xff"]`, which git accepts and uses) is not listed and the check passes; then the
 * release's first `git status` re-hashes README.md through the named program. ops/trust-config.ts gitProgramDrivers
 * runs git with PATH only (the C locale), so it does name the key: the two copies disagree.
 *
 * The planted clean filter passes the bytes through unchanged (`cat`), so the checkout still reads as clean, and only
 * appends a line to a file in the test's temporary folder.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-non-utf8-driver-name-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitProgramDrivers } from "../ops/trust-config.ts";
import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// the release script's own pattern (ops/release-robinhood.sh `drivers=`)
const SCRIPT_PATTERN = readFileSync(join(ROOT, "ops", "release-robinhood.sh"), "utf8").match(/config --get-regexp '([^']+)'/)![1]!;

/** A clone of this repository's HEAD set up as the release expects, with a clean filter named by the byte 0xff. */
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

  const ran = join(tmp, "NON-UTF8-NAMED-FILTER-RAN");
  const filter = join(tmp, "clean-filter.sh");
  writeFileSync(filter, `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(ran)}\nexec cat\n`);
  chmodSync(filter, 0o755);
  // the driver's name is the single byte 0xff (a quoted subsection may hold any byte but newline and NUL)
  const name = Buffer.from([0xff]);
  appendFileSync(join(repo, ".git", "config"), Buffer.concat([Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = ${filter} %f\n`)]));
  writeFileSync(join(repo, ".git", "info", "attributes"), Buffer.concat([Buffer.from("README.md filter="), name, Buffer.from("\n")]));
  const touch = (ahead: number) => { const t = new Date(Date.now() + ahead); utimesSync(join(repo, "README.md"), t, t); };
  return { tmp, repo, ran, touch };
}

describe("release: a driver named by a non-UTF-8 byte runs under a UTF-8 locale (adversary on cf03f94)", function () {
  this.timeout(900_000);

  it("a repository filter.\\xff.clean never runs during the release (LC_ALL=C.UTF-8)", () => {
    const { tmp, repo, ran, touch } = plantedCheckout("release-non-utf8-driver-");
    const uploaded = join(tmp, "uploaded-output");
    const env = { ...sealedReleaseEnv(tmp, uploaded), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

    // not vacuous: in the C locale git lists the key under the script's own pattern; in the release's UTF-8 locale it
    // does not; and a plain status with the release's own switches runs the program and still calls the checkout clean
    const sealed = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" };
    const list = (lc: string) => spawnSync("git", ["-C", repo, "config", "--get-regexp", SCRIPT_PATTERN], { env: { ...sealed, LC_ALL: lc } }).stdout.toString("latin1");
    assert.match(list("C"), /^filter\.\xff\.clean /, "precondition: in the C locale git lists the planted key under the script's pattern");
    assert.equal(gitProgramDrivers(repo).length, 1,
      "precondition: ops/trust-config.ts gitProgramDrivers names the key");
    touch(5_000);
    const safe = ["-C", repo, "--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null"];
    assert.equal(execFileSync("git", [...safe, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], { env: sealed, encoding: "utf8" }), "",
      "precondition: the checkout reads as clean");
    assert.ok(existsSync(ran), "precondition: the release's status runs the planted clean filter");
    rmSync(ran);
    touch(60_000); // stat data changed again, as after any editor save or checkout

    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-10).join("\n");
    assert.equal(existsSync(ran), false,
      `the release ran the program named by the repository's filter.\\xff.clean (under LC_ALL=C.UTF-8 the script's pattern lists ${JSON.stringify(list("C.UTF-8"))}):\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}(release exit ${r.status}, deployed ${existsSync(uploaded)})\n${tail}`);
  });
});
