/**
 * Adversary (f22a780): a deployment whose files changed during the upload is recorded as voidedDeploymentUrl, but only
 * when the second digest returns. If the output folder is removed during the upload, artifactDigest throws, the known
 * URL is never written, and the operator is not told to remove or roll it back.
 *
 *   npx mocha --import=tsx tests/release-deploy-voided-throw-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { fakePinnedCli } from "./fake-pinned-cli.ts";
import { VERCEL_CLI, artifactDigest, writeRecord, type ReleaseRecord } from "../ops/trust-config.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DEPLOY_URL = "https://othello-abc123-jesterkeri.vercel.app";

describe("adversary: a deployment voided by a removed output folder", () => {
  it("still names the deployed URL in the record as voided", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-voided-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), "console.log('client chunk')");
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), COMMIT, null, root);
    const git: Git = { head: () => COMMIT, changed: () => ["release/robinhood-prebuilt.json", "release/robinhood-prebuilt.files.txt"] };
    // the CLI uploads and prints the URL; meanwhile the output folder is removed (a rebuild, a clean)
    const run: Run = async () => {
      rmSync(out, { recursive: true, force: true });
      return { code: 0, stdout: `Vercel CLI ${VERCEL_CLI}\n${DEPLOY_URL}\n` };
    };
    let reason = "";
    try {
      const r = await deployRecorded({ cli: fakePinnedCli(), root, recordFile: record, prod: true, run, git });
      reason = r.ok ? "ok" : r.reason;
    } catch (e) {
      reason = `threw: ${e instanceof Error ? e.message : e}`;
    }
    const rec = JSON.parse(readFileSync(record, "utf8")) as ReleaseRecord;
    assert.equal(rec.deploymentUrl, null);
    assert.equal(rec.voidedDeploymentUrl, DEPLOY_URL,
      `${DEPLOY_URL} was deployed to production from files that changed during the upload, but the record does not name it (deploy result: ${reason})`);
  });
});
