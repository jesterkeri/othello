/**
 * Adversary test for ops/release-robinhood.sh (Codex code review r3 M1: "the record describes what was deployed").
 *
 * The EXIT trap now copies a record that carries deployStartedAt back to the checkout, and on a failed copy only
 * prints a line and deletes the fresh clone anyway ("The copy cannot stop the clean-up"). So when the copy fails after
 * a COMPLETED deploy, the only record of that deploy is deleted, the checkout keeps the previous release's record (or
 * half of the new one), and the release still exits 0.
 *
 * The test clones this repository at HEAD, commits a previous release's deployed record (made with the repo's own
 * writeRecord), and makes that committed record read-only in the checkout (git tracks no write bit, so the checkout
 * stays clean). It runs the real ops/release-robinhood.sh in the sealed harness (pull stubbed, empty HOME, null
 * factory, so no network). The deploy step runs the real deployRecorded from the clone's ops/release-deploy.ts with
 * the real verified CLI path, but its Vercel runner is replaced by one that prints a deployment URL, so nothing
 * contacts Vercel. The deploy completes; a release that exits 0 must leave that deploy's record in the checkout.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-deploy-record-copy-failure-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealedReleaseEnv } from "./release-script-harness.ts";
import { writeRecord } from "../ops/trust-config.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PREVIOUS_URL = "https://othello-previous-release.vercel.app";
const NEW_URL = "https://othello-new-release-adv.vercel.app";

describe("release adversary: a failed copy-back loses a completed deploy's record", function () {
  this.timeout(1_800_000);

  it("a release that exits 0 after a completed deploy leaves that deploy's record in the checkout", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-record-copy-"));
    const repo = join(tmp, "repo");
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=adv", "-c", "user.email=adv@example.invalid", ...a], { encoding: "utf8" });
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    const vercelDir = join(repo, "app", ".vercel");
    mkdirSync(vercelDir, { recursive: true });
    writeFileSync(join(vercelDir, "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: { framework: "nextjs", installCommand: "true" } }));

    // the previous release, recorded, deployed and committed (TRUSTED_FACTORY stays null: the run needs no network)
    const recordFile = join(repo, "release", "robinhood-prebuilt.json");
    const listFile = join(repo, "release", "robinhood-prebuilt.files.txt");
    mkdirSync(join(repo, "release"));
    const prevCommit = git("rev-parse", "HEAD").trim();
    writeRecord(recordFile, { sha256: "ab".repeat(32), files: 1, lines: [`${"ab".repeat(32)}  100644  1  config.json`] }, prevCommit, null, repo);
    const prev = JSON.parse(readFileSync(recordFile, "utf8"));
    writeFileSync(recordFile, JSON.stringify({ ...prev, deployStartedAt: prev.scannedAt, deploymentUrl: PREVIOUS_URL, target: "preview", deployedAt: prev.scannedAt }, null, 2) + "\n");
    git("add", "-A");
    git("commit", "-q", "-m", "release: record the previous deploy");
    chmodSync(recordFile, 0o444); // read-only in the checkout; git records no write bit
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "precondition: the checkout is clean");

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    // the deploy step: the clone's real deployRecorded, real CLI check, real rehashes; only the Vercel call is replaced
    const stub = join(tmp, "deploy-stub.mts");
    writeFileSync(stub, `
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const { deployRecorded } = await import(pathToFileURL(join(root, "ops", "release-deploy.ts")).href);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const git = {
  head: () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  changed: () => execFileSync("git", ["-C", root, "status", "--porcelain", "--no-renames", "--untracked-files=all"], { encoding: "utf8" })
    .split("\\n").filter(Boolean).map((l) => l.slice(3)),
};
const run = async () => ({ code: 0, stdout: ${JSON.stringify(NEW_URL)} + "\\n" });
const r = await deployRecorded({ root, recordFile: resolve(root, arg("--record")), prod: false, run, git, cli: arg("--cli"), env: process.env });
console.error("stub deploy:", JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
`);
    const shim = join(tmp, "shim", "node");
    writeFileSync(shim,
      `#!/bin/sh\ncase " $* " in\n` +
      `  *" ops/release-deploy.ts --run-cli "*" pull "*) echo "shim: pull skipped" >&2; exit 0;;\n` +
      `  *" ops/release-deploy.ts --record "*) exec ${JSON.stringify(process.execPath)} "$1" --no-cache ${JSON.stringify(stub)} "$@";;\n` +
      `esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(shim, 0o755);

    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-15).join("\n");

    // not vacuous: the deploy step ran and completed with the new URL
    assert.match(out, new RegExp(`stub deploy: \\{"ok":true,"url":"${NEW_URL.replace(/[.]/g, "\\.")}"\\}`), tail);

    const rec = JSON.parse(readFileSync(recordFile, "utf8"));
    const list = readFileSync(listFile, "utf8");
    const listSha = createHash("sha256").update(list.replace(/\n$/, "")).digest("hex");
    if (r.status === 0) {
      assert.equal(rec.deploymentUrl, NEW_URL,
        `the release exited 0 after deploying ${NEW_URL}, but the checkout's record still says ${rec.deploymentUrl} ` +
        `(commit ${rec.commit}, artifact ${rec.artifactSha256}); its file list hashes to ${listSha}, ` +
        `record/list ${rec.artifactSha256 === listSha ? "agree" : "DISAGREE"}\n${tail}`);
      assert.equal(listSha, rec.artifactSha256, "the checkout's file list is the record's");
    } else {
      // a fix may refuse instead; then the completed deploy's record must still exist where the output says
      const kept = [...out.matchAll(/(\/\S+robinhood-prebuilt\.json)/g)].map((m) => m[1]!).filter((p) => existsSync(p));
      assert.ok(kept.some((p) => JSON.parse(readFileSync(p, "utf8")).deploymentUrl === NEW_URL),
        `the release failed (exit ${r.status}) and no surviving file it names holds the deploy of ${NEW_URL}\n${tail}`);
    }
  });
});
