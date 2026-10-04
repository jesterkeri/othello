/**
 * Adversary test on 4570ded (requirement: no program named by configuration, the caller's or the repository's own,
 * may run in any git call of the release path, from its first call).
 *
 * The release refuses a repository whose own config names a filter, diff or merge driver, and safe_git overrides
 * core.fsmonitor and core.hooksPath. A repository's `core.pager` with `pager.status=true` is neither: when the release
 * finds an uncommitted change it prints `safe_git status --short >&2`, and when the operator's terminal is stderr (as
 * when the script is run by hand, the documented way) git starts the configured pager program on it.
 *
 * The terminal is a pseudo-terminal from util-linux `script`. The planted pager copies its input through (`cat`) and
 * only appends a line to a file in the test's temporary folder.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-repo-pager-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release: no pager named by the repository's config runs (adversary on 4570ded)", function () {
  this.timeout(900_000);

  it("a repository core.pager never runs when the release reports an uncommitted change on a terminal", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-repo-pager-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    const ran = join(tmp, "PAGER-RAN");
    const pager = join(tmp, "pager.sh");
    writeFileSync(pager, `#!/bin/sh\necho "$PWD" >> ${JSON.stringify(ran)}\nexec cat\n`);
    chmodSync(pager, 0o755);
    execFileSync("git", ["-C", repo, "config", "core.pager", pager]);
    execFileSync("git", ["-C", repo, "config", "pager.status", "true"]);
    writeFileSync(join(repo, "UNCOMMITTED.txt"), "an untracked file the release must report\n");
    const env = sealedReleaseEnv(tmp, join(tmp, "uploaded-output"));

    const r = spawnSync("script", ["-qec", `bash ${JSON.stringify(join(repo, "ops", "release-robinhood.sh"))}`, "/dev/null"],
      { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /commit, discard or remove changes/, `not vacuous: the release must reach its uncommitted-change report:\n${out}`);
    assert.equal(existsSync(ran), false,
      `the release ran the pager program named by the repository's config:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}(release exit ${r.status})`);
  });
});
