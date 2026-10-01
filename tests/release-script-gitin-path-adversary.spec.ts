/**
 * Adversary pass on 275f514 (Codex r6 F1, requirement: every system tool the release itself uses runs by absolute
 * path; evm/ARB-FINDINGS.md F-40 lists git among them, "so PATH only ever supplies the operator's own toolchain (node,
 * pnpm, npm, forge)", and tests/release-script-path-trust.spec.ts says "git always runs as /usr/bin/git").
 *
 * The script's own git calls are /usr/bin/git, but the release's TypeScript steps call git through gitIn and
 * gitProgramDrivers (ops/trust-config.ts), which spawn the bare name "git" and so take the first `git` on PATH: in
 * release-deploy.ts --preflight, in trust-config.ts --record, in the deploy step's record checks. A `git` in a PATH
 * folder the filter keeps, ahead of /usr/bin, runs in the release and answers its HEAD, status and drivers checks.
 *
 * The run is the real release under tests/release-script-harness.ts (no Vercel); its shim folder, kept on PATH as the
 * operator's own, also holds a `git` that records gitIn's calls (they carry gitIn's pinned `--work-tree=` and
 * `core.checkStat=default`) and then runs /usr/bin/git, so the release otherwise behaves as normal.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-gitin-path-adversary.spec.ts
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

describe("release: git is never taken from PATH (adversary pass on 275f514)", function () {
  this.timeout(900_000);

  it("a git on PATH ahead of /usr/bin is not run by the release's own checks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-gitin-path-"));
    const repo = join(tmp, "repo");
    execFileSync("/usr/bin/git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    const head = commitTestReleaseTarget(repo);

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const ran = join(tmp, "GIT-RAN");
    const shim = join(tmp, "shim"); // the harness's own folder, first on PATH and kept as the operator's own
    writeFileSync(join(shim, "git"), `#!/bin/sh\necho "git $*" >> ${JSON.stringify(ran)}\nexec /usr/bin/git "$@"\n`);
    chmodSync(join(shim, "git"), 0o755);

    const r = spawnSync("/bin/bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
    // not vacuous: the release ran end to end with the recording git in place
    assert.ok(r.status === 0 && existsSync(uploaded) && out.includes(`Released from a fresh clone of ${head}`),
      `precondition: the release completes (exit ${r.status}):\n${tail}`);

    const gitInCalls = (existsSync(ran) ? readFileSync(ran, "utf8") : "").split("\n")
      .filter((l) => l.includes("--work-tree=") && l.includes("core.checkStat=default"));
    const commands = [...new Set(gitInCalls.map((l) => l.split(" core.ignoreCase=false ")[1] ?? l))];
    assert.equal(gitInCalls.length, 0,
      `the release's own git calls (gitIn) ran the git found on PATH, not /usr/bin/git: ${gitInCalls.length} calls, e.g.\n` +
      commands.slice(0, 8).map((c) => `  git ... ${c.slice(0, 120)}`).join("\n"));
  });
});
