/**
 * Adversary (28df8a6): the reviewed target (ops/release-target.json) is checked only by `--preflight`, never by
 * deployRecorded, the step that contacts Vercel. release-deploy.ts documents `--record` as its own entry point, and
 * every record trust-config writes says `deploy: npx tsx ops/release-deploy.ts --record ...`. A record scanned in a
 * checkout whose app/.vercel/project.json is a stale link to another team and project binds that link's hash, so the
 * digest agrees and the deploy goes to the unreviewed project. releaseTargetRefusals' own contract: "the caller's
 * app/.vercel/project.json must name exactly those, or nothing is pulled, built or deployed".
 *
 *   npx mocha --import=tsx tests/release-deploy-target-at-deploy-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, releaseTargetRefusals, type Git, type Run } from "../ops/release-deploy.ts";
import { commitTarget, fakePinnedCli, reviewedProjectEnv } from "./fake-pinned-cli.ts";
import { REVIEWED_ENV_NAMES, REVIEWED_SETTINGS } from "./reviewed-settings.ts";
import { VERCEL_CLI, artifactDigest, writeRecord } from "../ops/trust-config.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DEPLOY_URL = "https://other-abc123-someoneelse.vercel.app";

describe("adversary: the deploy step itself does not enforce the reviewed Vercel target", () => {
  it("refuses to deploy when app/.vercel/project.json names another team and project than ops/release-target.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-target-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    // the reviewed target, committed (the release reads it from HEAD, adversary pass on 222e3fc)
    commitTarget(root, { vercelOrgId: "team_A", vercelProjectId: "prj_A", vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES });
    // a stale link to a project the operator can also deploy to
    writeFileSync(join(app, ".vercel", "project.json"), JSON.stringify({ orgId: "team_B", projectId: "prj_B", settings: REVIEWED_SETTINGS }));
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), "console.log('client chunk')");
    // the preflight would refuse this link: the check exists, it is just not on the deploy path
    assert.equal(releaseTargetRefusals(root, app).length, 2);
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), COMMIT, null, root);
    const git: Git = { head: () => COMMIT, changed: () => ["release/robinhood-prebuilt.json", "release/robinhood-prebuilt.files.txt"] };
    let contacted = false;
    const run: Run = async () => {
      contacted = true;
      return { code: 0, stdout: `Vercel CLI ${VERCEL_CLI}\n${DEPLOY_URL}\n` };
    };
    const r = await deployRecorded({ projectEnv: reviewedProjectEnv, cli: fakePinnedCli(), root, recordFile: record, prod: true, run, git, env: {} });
    assert.ok(!contacted && !r.ok,
      `the pinned CLI was started for a production deploy linked to team_B/prj_B, not the reviewed team_A/prj_A (deploy result: ${JSON.stringify(r)})`);
  });
});
