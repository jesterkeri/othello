/**
 * Adversary (222e3fc): the reviewed input is the COMMITTED ops/release-target.json (Codex r4 F1: "Pin the expected
 * `orgId` and `projectId` in a reviewed release-target input"). `--run-cli`, which the release documents as an entry
 * point of its own and which now checks the target for itself, reads the file from the working tree and never asks
 * whether it is the committed one. An uncommitted edit that names another project, with app/ linked to that project,
 * passes the runner's preflight and the pinned CLI is started for `pull` against a project nobody reviewed.
 * (`--record` does not have this gap: deployRecorded refuses any changed file but the record.)
 *
 * The test copies release-deploy.ts, trust-config.ts, the committed CLI lock and the committed ops/release-target.json
 * into a temporary git repository and commits them, so HEAD holds the reviewed target. The "pinned CLI" is a folder
 * that passes verifyPinnedCli (the committed lockfile, a vercel package.json at VERCEL_CLI) whose vc.js only writes a
 * marker file: nothing can contact Vercel.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-uncommitted-target-adversary.spec.ts
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
const REVIEWED = JSON.parse(readFileSync(join(REPO, "ops", "release-target.json"), "utf8")) as { vercelOrgId: string; vercelProjectId: string };

/** A committed checkout whose HEAD holds the reviewed target; `edit` (if given) is then written over it, uncommitted. */
function runCliPull(edit: { vercelOrgId: string; vercelProjectId: string } | null) {
  const root = mkdtempSync(join(tmpdir(), "release-uncommitted-target-"));
  mkdirSync(join(root, "ops", "vercel-cli"), { recursive: true });
  for (const f of ["release-deploy.ts", "trust-config.ts", "release-target.json", "vercel-cli/package.json", "vercel-cli/package-lock.json"]) {
    copyFileSync(join(REPO, "ops", f), join(root, "ops", f));
  }
  writeFileSync(join(root, ".gitignore"), "node_modules\napp/.vercel\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...a], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "reviewed target");
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules")); // typescript and viem for trust-config's imports
  const target = edit ?? REVIEWED;
  if (edit) writeFileSync(join(root, "ops", "release-target.json"), JSON.stringify(edit) + "\n"); // not committed, not reviewed
  mkdirSync(join(root, "app", ".vercel"), { recursive: true });
  writeFileSync(join(root, "app", ".vercel", "project.json"), JSON.stringify({ orgId: target.vercelOrgId, projectId: target.vercelProjectId, settings: {} }));
  const cli = mkdtempSync(join(tmpdir(), "release-uncommitted-vc-"));
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
  const status = git("status", "--porcelain");
  return { r, status, started: existsSync(marker) ? readFileSync(marker, "utf8") : null };
}

describe("adversary: --run-cli trusts an uncommitted ops/release-target.json", () => {
  it("control: a clean checkout linked to the committed target does start the pinned CLI", () => {
    const { r, status, started } = runCliPull(null);
    assert.equal(status, "", "the checkout is clean");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(started ?? "null")?.args, ["pull", "--yes", "--environment=production"]);
  });

  it("an uncommitted target naming another project, and a link to it: the pinned CLI is never started for pull", () => {
    const other = { vercelOrgId: "team_UnreviewedTeam0000000000", vercelProjectId: "prj_UnreviewedProject000000000" };
    const { r, status, started } = runCliPull(other);
    assert.equal(status.trim(), "M ops/release-target.json", "only the target differs from the commit");
    assert.equal(started, null,
      `--run-cli started the pinned CLI for \`pull\` against ${other.vercelOrgId}/${other.vercelProjectId}, named only by an ` +
      `uncommitted ops/release-target.json (HEAD names ${REVIEWED.vercelOrgId}/${REVIEWED.vercelProjectId}); exit ${r.status}; CLI saw ${started}`);
    assert.notEqual(r.status, 0, "and it refuses");
  });
});
