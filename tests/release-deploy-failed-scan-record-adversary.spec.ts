/**
 * Adversary test for ops/release-robinhood.sh (Codex code review r3 M1: "the record must describe what was deployed").
 *
 * The release now copies the fresh clone's release record back to the checkout from an EXIT trap, on ANY exit. But
 * ops/trust-config.ts writes the record (--record) BEFORE it verifies a set TRUSTED_FACTORY against the receipt and
 * the chain, and only then exits 1 on a failure. So a trust-config run that FAILS still leaves a record in the clone,
 * and the trap copies it over the committed record of the last real deploy, in the checkout.
 *
 * The test clones this repository at HEAD, commits a set TRUSTED_FACTORY (no receipt) and a previous release's
 * deployed record (made with the repo's own writeRecord), and runs the real ops/release-robinhood.sh in the sealed
 * harness (pull and deploy stubbed, empty HOME) with ROBINHOOD_RPC pointed at a closed local port, so the chain check
 * fails without any network. trust-config must fail, and the checkout must still hold the committed record.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-deploy-failed-scan-record-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { writeRecord } from "../ops/trust-config.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FACTORY = "0x1111111111111111111111111111111111111111";
const CODE_HASH = `0x${"22".repeat(32)}`;
const PREVIOUS_URL = "https://othello-previous-release.vercel.app";

describe("release adversary: a failed trust-config run replaces the committed record", function () {
  this.timeout(1_800_000);

  it("the checkout keeps the last deployed record when trust-config fails after writing one", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-failed-scan-record-"));
    const repo = join(tmp, "repo");
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=adv", "-c", "user.email=adv@example.invalid", ...a], { encoding: "utf8" });
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    const vercelDir = join(repo, "app", ".vercel");
    mkdirSync(vercelDir, { recursive: true });
    writeFileSync(join(vercelDir, "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo); // the release refuses any link but the reviewed target's (Codex r4 F1)

    // the config commit: a set factory, as after DeployFactory; the release of the previous commit is recorded and deployed
    const cfg = join(repo, "app", "src", "lib", "robinhood", "config.ts");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(
      "export const TRUSTED_FACTORY: TrustedFactory | null = null;",
      `export const TRUSTED_FACTORY: TrustedFactory | null = Object.freeze({ address: "${FACTORY}", codeHash: "${CODE_HASH}" });`));
    const recordFile = join(repo, "release", "robinhood-prebuilt.json");
    mkdirSync(join(repo, "release"));
    const prevCommit = git("rev-parse", "HEAD").trim();
    writeRecord(recordFile, { sha256: "ab".repeat(32), files: 1, lines: [`${"ab".repeat(32)}  100644  1  config.json`] }, prevCommit, null, repo);
    const prev = JSON.parse(readFileSync(recordFile, "utf8"));
    writeFileSync(recordFile, JSON.stringify({ ...prev, deployStartedAt: prev.scannedAt, deploymentUrl: PREVIOUS_URL, target: "preview", deployedAt: prev.scannedAt }, null, 2) + "\n");
    git("add", "-A");
    git("commit", "-q", "-m", "config: set the trusted factory");
    const committed = readFileSync(recordFile, "utf8");
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "precondition: the checkout is clean");

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    env.ROBINHOOD_RPC = "http://127.0.0.1:9"; // closed: trust-config's chain check fails, nothing leaves this machine
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-15).join("\n");

    // not vacuous: the run reached trust-config, whose scan passed and whose chain check then failed; nothing was deployed.
    // (Adapted to the fix, F-17 twentieth pass: trust-config now writes its record only after every check, so a failed
    // run writes none, and the release copies back only a record whose deploy started.)
    assert.notEqual(r.status, 0, `the release should fail:\n${tail}`);
    assert.match(out, /trust-config: the artifact at app\/\.vercel\/output \([0-9]+ files, sha256 [0-9a-f]+\) contains only allowed addresses/, tail);
    assert.match(out, /trust-config FAILED/, tail);
    assert.doesNotMatch(out, /release record written/, "a failed trust-config run writes no record");
    assert.ok(!existsSync(uploaded), "nothing reached the deploy step");

    const now = readFileSync(recordFile, "utf8");
    const rec = JSON.parse(now);
    assert.equal(now, committed,
      `a trust-config run that FAILED replaced the committed record in the checkout: it now says trustedFactory ` +
      `${rec.trustedFactory}, artifact ${rec.artifactSha256}, deploymentUrl ${rec.deploymentUrl} (was ${PREVIOUS_URL}); ` +
      `git status: ${git("status", "--porcelain").trim()}`);
  });
});
