/**
 * Adversary test for ops/release-deploy.ts repoRootRefusals / deployRecorded (Codex code review r3 M1: the release must
 * bind what Vercel receives, deployed by the pinned CLI).
 *
 * repoRootRefusals refuses `node_modules/vercel` and `node_modules/.bin/vercel` in the root and in app/, as "a local
 * Vercel CLI that npx would run instead of the pinned one". But `npx --yes vercel@59.11.7 ...` (npm 10, libnpmexec
 * lib/index.js, the needPackageCommandSwap branch) first looks for a bin file named after the whole first argument,
 * `node_modules/.bin/vercel@59.11.7`, in app/ and every folder above it (lib/file-exists.js localFileExists, walking up
 * to "/"), and when one exists it runs that file, never resolving the registry package. app/node_modules/ is
 * gitignored, so git status does not show it, and the upload scans skip node_modules.
 *
 * Inputs are constructed here in a temporary directory. The only real command run is `npx --yes vercel@59.11.7
 * --version` with the release's own allow-listed environment (deployEnv), which is harmless whichever binary answers.
 * No network is needed, no login, no deploy.
 *
 *   npx mocha --import=tsx tests/release-deploy-npx-versioned-bin-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployEnv, deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { fakePinnedCli, reviewedProjectEnv, reviewedTarget } from "./fake-pinned-cli.ts";
import { VERCEL_CLI, artifactDigest, writeRecord } from "../ops/trust-config.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SENTINEL = "https://planted-not-the-pinned-cli.vercel.app";

describe("release deploy adversary: a versioned bin name that npx runs before the registry package", function () {
  this.timeout(120_000);

  it("app/node_modules/.bin/vercel@59.11.7, which npx runs instead of the pinned CLI, is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-npx-bin-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), "console.log('client chunk')");
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "othello-app", private: true }));
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    reviewedTarget(root); // a reviewed link before the record (Codex r4 F1)
    writeRecord(record, artifactDigest(out, app), COMMIT, null, root);

    // the planted binary, in the gitignored app/node_modules/.bin, named after npx's whole first argument
    const bin = join(app, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const planted = join(bin, `vercel@${VERCEL_CLI}`);
    writeFileSync(planted, `#!/bin/sh\necho ${SENTINEL}\n`);
    chmodSync(planted, 0o755);

    // precondition: the exact npx invocation the release uses, from app/ with the release's environment, runs the
    // planted file and not vercel@59.11.7
    const said = execFileSync("npx", ["--yes", `vercel@${VERCEL_CLI}`, "--version"], { cwd: app, env: deployEnv(process.env), encoding: "utf8" });
    assert.match(said, new RegExp(SENTINEL.replace(/[.]/g, "\\.")), `precondition: npx ran the planted bin (${JSON.stringify(said)})`);

    const calls: { cmd: string; args: string[] }[] = [];
    const run: Run = async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "https://othello-abc123-jesterkeri.vercel.app\n" }; };
    const git: Git = { head: () => COMMIT, changed: () => ["release/robinhood-prebuilt.json", "release/robinhood-prebuilt.files.txt"] };
    const r = await deployRecorded({ projectEnv: reviewedProjectEnv, cli: fakePinnedCli(), target: reviewedTarget(root), root, recordFile: record, prod: false, run, git, env: {} });
    // Adapted to the fix (F-17, thirteenth pass): the deploy never goes through npx, so the planted name is never
    // resolved; the one command run is node with the verified pinned CLI's vc.js.
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls, [{ cmd: process.execPath, args: [fakePinnedCli(), "deploy", "--prebuilt"] }],
      `the deploy ran ${JSON.stringify(calls)}, not the verified CLI (npx would run ${planted})`);
    assert.ok(calls.every((c) => !/npx/.test(c.cmd) && !c.args.some((a) => a.includes(`vercel@${VERCEL_CLI}`))), "never npx");
  });
});
