/**
 * Adversary (b52d03f): the check after the upload now runs inside try/catch, but the write of the voided record after
 * it does not. If a clean during the upload removes the output AND the release folder (git clean -fdx in the clone),
 * the check voids the deploy, writeRecordAtomically throws ENOENT, and deployRecorded rejects: the operator gets a bare
 * file error, never the deployment URL, and in production is never told to roll it back.
 *
 *   npx mocha --import=tsx tests/release-deploy-void-write-throw-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { fakePinnedCli } from "./fake-pinned-cli.ts";
import { VERCEL_CLI, artifactDigest, writeRecord } from "../ops/trust-config.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DEPLOY_URL = "https://othello-abc123-jesterkeri.vercel.app";

describe("adversary: a voided deployment whose record cannot be written", () => {
  it("still returns a failure that names the deployed URL and says roll back", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-void-write-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), "console.log('client chunk')");
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), COMMIT, null, root);
    const git: Git = { head: () => COMMIT, changed: () => ["release/robinhood-prebuilt.json", "release/robinhood-prebuilt.files.txt"] };
    // the CLI uploads to production and prints the URL; meanwhile a clean removes the build and the release folder
    const run: Run = async () => {
      rmSync(out, { recursive: true, force: true });
      rmSync(join(root, "release"), { recursive: true, force: true });
      return { code: 0, stdout: `Vercel CLI ${VERCEL_CLI}\n${DEPLOY_URL}\n` };
    };
    let reason: string;
    try {
      const r = await deployRecorded({ cli: fakePinnedCli(), root, recordFile: record, prod: true, run, git });
      reason = r.ok ? `ok: recorded as deployed ${r.url}` : r.reason;
    } catch (e) {
      reason = `threw: ${e instanceof Error ? e.message : e}`;
    }
    assert.ok(reason.includes(DEPLOY_URL) && /roll back/.test(reason),
      `${DEPLOY_URL} is live in production from a voided upload, but the operator is told neither its URL nor to roll it back (deploy result: ${reason})`);
  });
});
