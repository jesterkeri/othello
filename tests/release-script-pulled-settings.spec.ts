/**
 * Codex code review r5 F1: `vercel pull` writes the project's build settings into app/.vercel/project.json, and the
 * pinned CLI's build runs `settings.installCommand` (and hands buildCommand and outputDirectory to the builder) in a
 * folder that already holds the pulled env files. A same-team, same-project link with a custom install or build
 * command passed both preflights, so unreviewed code ran inside the sealed build.
 *
 * The test first proves the attack (not vacuous): the pinned CLI, given such a link, runs the planted install command.
 * Then it runs the real ops/release-robinhood.sh in the sealed harness (pull stubbed, so the link stands for what pull
 * wrote; deploy stubbed; no Vercel login) with the correct ids and that link, and asserts the build runner never
 * started: the planted command never ran, nothing was built, and the release refused naming the setting.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-pulled-settings.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deployEnv } from "../ops/release-deploy.ts";
import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function clone(tmp: string, name: string, settings: object): string {
  const repo = join(tmp, name);
  execFileSync("git", ["clone", "--quiet", ROOT, repo]);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
  appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
  mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
  // the ids are the reviewed target's; only the settings (what pull wrote) are not the reviewed document
  writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings }));
  commitTestReleaseTarget(repo);
  return repo;
}

describe("release: the build never runs a project's own install or build command (Codex r5 F1)", function () {
  this.timeout(900_000);

  it("a pulled link with the reviewed ids but a custom installCommand/buildCommand stops the release before the build", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-pulled-settings-"));
    const ran = join(tmp, "PLANTED-COMMAND-RAN");
    const plant = (what: string) => `node -e "require('fs').appendFileSync('${ran}', '${what}\\n'); process.exit(3)"`;
    const hostile = { ...REVIEWED_SETTINGS, installCommand: plant("install"), buildCommand: plant("build") };

    // not vacuous: the pinned CLI, given this link, runs the planted install command
    const control = clone(tmp, "control", hostile);
    const cliDir = join(tmp, "cli");
    mkdirSync(cliDir);
    const vc = execFileSync("npx", ["tsx", join(ROOT, "ops", "release-deploy.ts"), "--install-cli", cliDir], { encoding: "utf8" }).trim();
    spawnSync(process.execPath, [vc, "build", "--yes"], { cwd: join(control, "app"), env: { ...deployEnv(process.env), NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore" });
    assert.ok(existsSync(ran), "precondition: the pinned CLI's build runs the link's installCommand");

    // the release, with the same link in a fresh checkout
    const repo = clone(tmp, "repo", hostile);
    rmSync(ran);
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
    assert.equal(existsSync(ran), false, `the release ran the project's own command (exit ${r.status}):\n${tail}`);
    assert.notEqual(r.status, 0, `the release went on with unreviewed build settings:\n${tail}`);
    assert.match(out, /REFUSED before the CLI started[\s\S]*settings\.installCommand is "node -e[\s\S]*settings\.buildCommand is "node -e/,
      `the release did not refuse naming the settings:\n${tail}`);
    // the pull step ran (stubbed) and the build runner never started the CLI
    assert.match(out, /shim: pull skipped/);
    assert.doesNotMatch(out, /Detected Next\.js version|Running "install" command/);
    assert.equal(existsSync(uploaded), false, "nothing reached the deploy step");
  });
});
