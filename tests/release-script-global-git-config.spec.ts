/**
 * Codex code review r5 F2: the release script's first git calls (rev-parse, the clean-checkout status) ran before it
 * turned global git configuration off, so a program named by the preserved HOME's (or XDG_CONFIG_HOME's) git config,
 * such as `core.fsmonitor`, ran during the release. Every git call is now safe_git, sealed before the first one.
 *
 * The test plants a `core.fsmonitor` hook in both global config files the release keeps (HOME and XDG_CONFIG_HOME are
 * on its allow-list), proves that hook runs on a plain `git status` in the clone (not vacuous), then runs the real
 * ops/release-robinhood.sh in the sealed harness (pull and deploy stubbed, no Vercel login) and asserts the hook never
 * ran while the release built and reached its deploy step.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-global-git-config.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release: no program named by the caller's global git config runs (Codex r5 F2)", function () {
  this.timeout(900_000);

  it("a hostile core.fsmonitor in HOME's and XDG_CONFIG_HOME's git config never runs during the release", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-global-git-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const ran = join(tmp, "FSMONITOR-RAN");
    const hook = join(tmp, "fsmonitor-hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(ran)}\nexit 1\n`);
    chmodSync(hook, 0o755);
    const config = `[core]\n\tfsmonitor = ${hook}\n`;
    writeFileSync(join(env.HOME!, ".gitconfig"), config);
    const xdg = join(tmp, "xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "config"), config);
    env.XDG_CONFIG_HOME = xdg;

    // not vacuous: in this environment a plain git status runs the planted program
    execFileSync("git", ["-C", repo, "status", "--porcelain"], { env, stdio: "ignore" });
    assert.ok(existsSync(ran), "precondition: the planted core.fsmonitor runs on a plain git status");
    rmSync(ran);

    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
    assert.equal(existsSync(ran), false,
      `the release ran the program named by the global git config:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n(exit ${r.status})\n${tail}`);
    // and the release really ran its git steps through to the build and the (stubbed) deploy
    assert.ok(r.status === 0 && existsSync(uploaded) && /Detected Next\.js version/.test(out),
      `the release did not build and reach its deploy step (exit ${r.status}, uploaded ${existsSync(uploaded)}):\n${tail}`);
  });
});
