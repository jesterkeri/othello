/**
 * Adversary test on ce04cd9 (Codex code review r5 F2: every git call of the release is sealed from its first call
 * against global configuration and any repository setting that runs a program; no configuration-named program runs).
 *
 * safe_git (ops/release-robinhood.sh) and gitIn (ops/trust-config.ts) override core.fsmonitor and core.hooksPath, but
 * not a filter driver. A repository's `filter.<name>.clean` (or `.process`), selected by `.git/info/attributes`, is a
 * repository setting that names a program, and `git status` runs it on every tracked file whose stat data no longer
 * matches the index (it must re-hash the file as it would be stored). The release's first git calls, the
 * clean-checkout `status`, run in the caller's own checkout, so the program runs.
 *
 * The planted clean filter passes the bytes through unchanged (`cat`), so the checkout still reads as clean, and only
 * appends a line to a file in the test's temporary folder.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-repo-filter-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release: no filter driver named by the repository's config runs (adversary on ce04cd9, Codex r5 F2)", function () {
  this.timeout(900_000);

  it("a repository filter.<name>.clean never runs during the release", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-repo-filter-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    const ran = join(tmp, "FILTER-RAN");
    const filter = join(tmp, "clean-filter.sh");
    writeFileSync(filter, `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(ran)}\nexec cat\n`);
    chmodSync(filter, 0o755);
    execFileSync("git", ["-C", repo, "config", "filter.adv.clean", `${filter} %f`]);
    writeFileSync(join(repo, ".git", "info", "attributes"), "README.md filter=adv\n");
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);

    // not vacuous: with README.md's stat data changed (content unchanged), a plain git status runs the planted filter
    const touch = (ahead: number) => { const t = new Date(Date.now() + ahead); utimesSync(join(repo, "README.md"), t, t); };
    touch(5_000);
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { env, encoding: "utf8" }), "", "precondition: the checkout reads as clean");
    assert.ok(existsSync(ran), "precondition: the planted clean filter runs on a plain git status");
    rmSync(ran);
    touch(60_000); // stat data changed again, as after any editor save or checkout

    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-10).join("\n");
    assert.equal(existsSync(ran), false,
      `the release ran the program named by the repository's filter config:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}(release exit ${r.status}, deployed ${existsSync(uploaded)})\n${tail}`);
  });
});
