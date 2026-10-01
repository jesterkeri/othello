/**
 * Adversary (be54588): the reviewed target (ops/release-target.json) is enforced by `--preflight` and by `--record`
 * (deployRecorded), but not by `--run-cli`, the entry point through which the release runs `vercel pull` and
 * `vercel build`. release-deploy.ts documents `--run-cli <vc.js> --cwd app -- <args>` as its own entry point ("runs the
 * verified CLI in the deploy's env"), exactly as it documents `--record`, whose missing check the previous round fixed
 * with "this entry point can be run on its own". Run on its own against a stale link to another project, `--run-cli
 * ... -- pull` starts the pinned CLI, which pulls that project's settings and environment into app/.vercel. The
 * contract (releaseTargetRefusals' doc comment): "the caller's app/.vercel/project.json must name exactly those, or
 * nothing is pulled, built or deployed".
 *
 * The test copies release-deploy.ts, trust-config.ts, the committed CLI lock and the committed ops/release-target.json
 * into a temporary root, links app/ to another project (once with another project in the reviewed team, once with the
 * reviewed project id under another team), and runs the real `--run-cli ... -- pull`. The "pinned CLI" is a folder
 * that passes verifyPinnedCli (the committed lockfile, a vercel package.json at VERCEL_CLI) whose vc.js only writes a
 * marker file: nothing can contact Vercel.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-run-cli-target-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERCEL_CLI } from "../ops/trust-config.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

function runCliPull(link: { orgId: string; projectId: string }) {
  const root = mkdtempSync(join(tmpdir(), "release-run-cli-target-"));
  mkdirSync(join(root, "ops", "vercel-cli"), { recursive: true });
  for (const f of ["release-deploy.ts", "trust-config.ts", "release-target.json", "vercel-cli/package.json", "vercel-cli/package-lock.json"]) {
    copyFileSync(join(REPO, "ops", f), join(root, "ops", f));
  }
  // the app manifest, which pins the reviewed Node.js version the preflight requires (adversary pass on ce04cd9)
  mkdirSync(join(root, "app"), { recursive: true });
  copyFileSync(join(REPO, "app", "package.json"), join(root, "app", "package.json"));
  // a committed checkout, since the release reads the reviewed target from HEAD (adversary pass on 222e3fc)
  writeFileSync(join(root, ".gitignore"), "node_modules\napp/.vercel\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "reviewed target");
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules")); // typescript and viem for trust-config's imports
  mkdirSync(join(root, "app", ".vercel"), { recursive: true });
  // a stale link to a project the operator can also deploy to
  writeFileSync(join(root, "app", ".vercel", "project.json"), JSON.stringify({ ...link, settings: {} }));
  // a folder verifyPinnedCli accepts, whose vc.js only records that it was started
  const cli = mkdtempSync(join(tmpdir(), "release-run-cli-vc-"));
  copyFileSync(join(REPO, "ops", "vercel-cli", "package-lock.json"), join(cli, "package-lock.json"));
  const pkg = join(cli, "node_modules", "vercel");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vercel", version: VERCEL_CLI }));
  const marker = join(cli, "started.json");
  writeFileSync(join(pkg, "dist", "vc.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`);
  const r = spawnSync(process.execPath, [TSX, "--no-cache", join(root, "ops", "release-deploy.ts"),
    "--run-cli", join(pkg, "dist", "vc.js"), "--cwd", "app", "--", "pull", "--yes", "--environment=production"],
  { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return { r, started: existsSync(marker) ? readFileSync(marker, "utf8") : null };
}

describe("adversary: --run-cli pulls against a link that is not the reviewed target", () => {
  it("control: the reviewed link itself does start the pinned CLI (the harness is not refusing everything)", () => {
    const target = JSON.parse(readFileSync(join(REPO, "ops", "release-target.json"), "utf8"));
    const { r, started } = runCliPull({ orgId: target.vercelOrgId, projectId: target.vercelProjectId });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(started ?? "null")?.args, ["pull", "--yes", "--environment=production"]);
  });

  it("another project in the reviewed team: the pinned CLI is never started for pull", () => {
    const target = JSON.parse(readFileSync(join(REPO, "ops", "release-target.json"), "utf8"));
    const { r, started } = runCliPull({ orgId: target.vercelOrgId, projectId: "prj_StaleOtherProject000000000" });
    assert.equal(started, null,
      `--run-cli started the pinned CLI for \`pull\` against projectId prj_StaleOtherProject000000000, not the reviewed ` +
      `${target.vercelProjectId} (exit ${r.status}; CLI saw ${started}; stderr: ${r.stderr.trim()})`);
    assert.notEqual(r.status, 0, "and it refuses");
  });

  it("the reviewed project id under another team: the pinned CLI is never started for pull", () => {
    const target = JSON.parse(readFileSync(join(REPO, "ops", "release-target.json"), "utf8"));
    const { r, started } = runCliPull({ orgId: "team_StaleOtherTeam00000000", projectId: target.vercelProjectId });
    assert.equal(started, null,
      `--run-cli started the pinned CLI for \`pull\` against orgId team_StaleOtherTeam00000000, not the reviewed ` +
      `${target.vercelOrgId} (exit ${r.status}; CLI saw ${started}; stderr: ${r.stderr.trim()})`);
    assert.notEqual(r.status, 0, "and it refuses");
  });
});
