/**
 * Adversary (9b44681): the reviewed input is ops/release-target.json AS COMMITTED AT HEAD (Codex r4 F1, and the
 * adversary pass on 222e3fc: "an edited copy ... is a refusal, never a pass"). committedTarget asks git for
 * `HEAD:ops/release-target.json` with replace objects on and the caller's GIT_* environment inherited, so:
 *
 *   1. `git replace <HEAD> <commit naming another project>` (a local ref under .git/refs/replace, never pushed, never
 *      reviewed) makes `cat-file blob HEAD:ops/release-target.json` return the other project, while `rev-parse HEAD` is
 *      still the reviewed commit and `git status` is clean. --run-cli then starts the pinned CLI for `pull` against a
 *      project nobody reviewed; deployRecorded's head and changed-file checks see nothing either.
 *   2. GIT_DIR pointing at another repository makes `rev-parse --show-toplevel` answer the release root (the cwd) and
 *      `cat-file` read that other repository's HEAD, so an uncommitted edit of the checkout's target passes --preflight.
 *
 * The test copies release-deploy.ts, trust-config.ts, the CLI lock and the committed ops/release-target.json into a
 * temporary git repository and commits them. The "pinned CLI" passes verifyPinnedCli and its vc.js only writes a marker
 * file: nothing can contact Vercel.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-replaced-head-target-adversary.spec.ts
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
const OTHER = { vercelOrgId: "team_UnreviewedTeam0000000000", vercelProjectId: "prj_UnreviewedProject000000000" };

const gitIn = (root: string) => (...a: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim();

/** A committed checkout whose HEAD holds the reviewed target, linked (app/.vercel/project.json) to `link`. */
function checkout(link: { vercelOrgId: string; vercelProjectId: string }) {
  const root = mkdtempSync(join(tmpdir(), "release-replaced-head-"));
  mkdirSync(join(root, "ops", "vercel-cli"), { recursive: true });
  for (const f of ["release-deploy.ts", "trust-config.ts", "release-target.json", "vercel-cli/package.json", "vercel-cli/package-lock.json"]) {
    copyFileSync(join(REPO, "ops", f), join(root, "ops", f));
  }
  // the app manifest, which pins the reviewed Node.js version the preflight requires (adversary pass on ce04cd9)
  mkdirSync(join(root, "app"), { recursive: true });
  copyFileSync(join(REPO, "app", "package.json"), join(root, "app", "package.json"));
  writeFileSync(join(root, ".gitignore"), "node_modules\napp/.vercel\n");
  const git = gitIn(root);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "reviewed target");
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules")); // typescript and viem for trust-config's imports
  mkdirSync(join(root, "app", ".vercel"), { recursive: true });
  writeFileSync(join(root, "app", ".vercel", "project.json"), JSON.stringify({ orgId: link.vercelOrgId, projectId: link.vercelProjectId, settings: {} }));
  return { root, git };
}

function fakeCli() {
  const cli = mkdtempSync(join(tmpdir(), "release-replaced-head-vc-"));
  copyFileSync(join(REPO, "ops", "vercel-cli", "package-lock.json"), join(cli, "package-lock.json"));
  const pkg = join(cli, "node_modules", "vercel");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vercel", version: VERCEL_CLI }));
  const marker = join(cli, "started.json");
  writeFileSync(join(pkg, "dist", "vc.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`);
  return { vc: join(pkg, "dist", "vc.js"), started: () => (existsSync(marker) ? readFileSync(marker, "utf8") : null) };
}

function deployTs(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [TSX, "--no-cache", join(root, "ops", "release-deploy.ts"), ...args],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
}

const pull = (vc: string) => ["--run-cli", vc, "--cwd", "app", "--", "pull", "--yes", "--environment=production"];

describe("adversary: the reviewed target is read through replace refs and the caller's GIT_DIR", () => {
  it("control: a clean checkout linked to the committed target does start the pinned CLI", () => {
    const { root } = checkout(REVIEWED);
    const cli = fakeCli();
    const r = deployTs(root, pull(cli.vc));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(cli.started() ?? "null")?.args, ["pull", "--yes", "--environment=production"]);
  });

  it("a replace ref over HEAD naming another project (HEAD and status unchanged): the pinned CLI is never started", () => {
    const { root, git } = checkout(OTHER);
    const reviewedHead = git("rev-parse", "HEAD");
    // a commit identical to HEAD but for the target, written only as a local replacement of HEAD
    writeFileSync(join(root, "ops", "release-target.json"), JSON.stringify(OTHER, null, 2) + "\n");
    git("add", "ops/release-target.json");
    const swapped = git("commit-tree", git("write-tree"), "-m", "reviewed target");
    git("replace", reviewedHead, swapped);
    assert.equal(git("rev-parse", "HEAD"), reviewedHead, "HEAD is still the reviewed commit");
    assert.equal(git("status", "--porcelain"), "", "git status shows nothing changed");
    assert.deepEqual(JSON.parse(git("--no-replace-objects", "cat-file", "blob", `${reviewedHead}:ops/release-target.json`)), REVIEWED,
      "the reviewed commit itself names the reviewed target");
    const cli = fakeCli();
    const r = deployTs(root, pull(cli.vc));
    assert.equal(cli.started(), null,
      `--run-cli started the pinned CLI for \`pull\` against ${OTHER.vercelOrgId}/${OTHER.vercelProjectId}, which only a local ` +
      `refs/replace entry names; HEAD ${reviewedHead} names ${REVIEWED.vercelOrgId}/${REVIEWED.vercelProjectId}; exit ${r.status}; CLI saw ${cli.started()}`);
    assert.notEqual(r.status, 0, "and it refuses");
  });

  it("GIT_DIR naming another repository and an uncommitted edit of the target: --preflight refuses", () => {
    const { root, git } = checkout(OTHER);
    writeFileSync(join(root, "ops", "release-target.json"), JSON.stringify(OTHER) + "\n"); // not committed here
    assert.equal(git("status", "--porcelain"), "M ops/release-target.json", "the checkout's target is an uncommitted edit");
    const elsewhere = mkdtempSync(join(tmpdir(), "release-replaced-head-other-"));
    mkdirSync(join(elsewhere, "ops"));
    writeFileSync(join(elsewhere, "ops", "release-target.json"), JSON.stringify(OTHER) + "\n");
    const g2 = gitIn(elsewhere);
    g2("init", "-q");
    g2("add", "-A");
    g2("commit", "-q", "-m", "not the reviewed target");
    const r = deployTs(root, ["--preflight"], { GIT_DIR: join(elsewhere, ".git") });
    assert.notEqual(r.status, 0,
      `--preflight passed an uncommitted ops/release-target.json naming ${OTHER.vercelOrgId}/${OTHER.vercelProjectId} because GIT_DIR ` +
      `pointed git at another repository; stderr: ${r.stderr}`);
  });
});
