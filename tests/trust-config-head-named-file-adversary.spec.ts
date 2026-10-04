/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts) rule 2 and its page-bundle promise: "the receipt
 * names the pinned DEPLOYED_COMMIT, which is an ancestor of HEAD, and since it nothing in CONTRACT_BUNDLE changed
 * ... whatever the file names" and "Page-bundle changes (anything outside CONTRACT_BUNDLE) must not fail the gate"
 * (adversary brief for 84043b3; ops/trust-config.ts header rule 2: "the page bundle ... may change after the deploy").
 *
 * changedSince() runs `git diff --no-renames --name-only -z --ignore-submodules=none <full> HEAD` with no `--`
 * after the revisions. git then checks that each revision argument is not also a file in the working tree, and
 * refuses ("ambiguous argument 'HEAD': both revision and filename"). So a committed root file named `HEAD` (or one
 * named after the deployed commit's full hash), a page-bundle change touching no contract file, makes changedSince
 * return null and the gate report "receipt commit ... is not an ancestor of HEAD" for the real, correct deployment.
 *
 * The git history is constructed in a temporary repository holding a copy of ops/trust-config.ts (its ROOT is the
 * directory above ops/), as in trust-config-moved-receipt-commit-adversary.spec.ts.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: a committed file named HEAD fails rule 2 for an unchanged contract bundle (ops/trust-config.ts changedSince)", function () {
  this.timeout(60_000);

  it("control: git itself refuses the revision pair once a file named HEAD is in the work tree", () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-head-file-ctl-"));
    const git = (...a: string[]) =>
      spawnSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(repo, "a"), "a\n");
    git("add", "a");
    git("commit", "-qm", "1");
    const first = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(repo, "b"), "b\n");
    git("add", "b");
    git("commit", "-qm", "2");
    assert.equal(git("diff", "--name-only", first, "HEAD").status, 0, "precondition: the plain diff works");
    writeFileSync(join(repo, "HEAD"), "x\n");
    git("add", "HEAD");
    git("commit", "-qm", "3");
    const r = git("diff", "--name-only", first, "HEAD");
    assert.equal(r.status, 128);
    assert.match(r.stderr, /ambiguous argument 'HEAD': both revision and filename/);
    assert.equal(git("diff", "--name-only", first, "HEAD", "--").status, 0, "with `--` the same diff works");
  });

  it("a page-bundle file named HEAD, added after the deploy, still lets changedSince list the (empty) bundle changes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-head-file-"));
    mkdirSync(join(repo, "ops"));
    mkdirSync(join(repo, "core/actions"), { recursive: true });
    cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(repo, "core/actions/standard.json"), '{"rounds": 10}\n');
    git("add", "ops", "core");
    git("commit", "-qm", "stands in for the reviewed, deployed commit");
    const deployedFull = git("rev-parse", "HEAD").trim();

    // after the deploy: a page-bundle change only (a root file, outside CONTRACT_BUNDLE)
    writeFileSync(join(repo, "HEAD"), "release notes\n");
    git("add", "HEAD");
    git("commit", "-qm", "page bundle: a root file named HEAD");

    const gateFile = join(repo, "ops/trust-config.ts");
    const pinned = readFileSync(gateFile, "utf8").replace(/^export const DEPLOYED_COMMIT = "[0-9a-f]{40}";$/m,
      `export const DEPLOYED_COMMIT = "${deployedFull}";`);
    assert.ok(pinned.includes(`DEPLOYED_COMMIT = "${deployedFull}"`), "precondition: the gate pins a deployed commit");
    writeFileSync(gateFile, pinned);
    const gate = (await import(pathToFileURL(gateFile).href)) as typeof import("../ops/trust-config.ts");
    assert.equal(gate.CONTRACT_BUNDLE("HEAD"), false, "precondition: HEAD is a page-bundle path");

    const changed = gate.changedSince(gate.DEPLOYED_COMMIT); // exactly what main() passes to verify() as changedSinceReceipt
    assert.notEqual(changed, null,
      "changedSince returned null (rule 2 then fails: 'not an ancestor of HEAD') although the deployed commit is HEAD's parent " +
      "and only a page-bundle file named HEAD changed");
    assert.deepEqual(changed!.filter(gate.CONTRACT_BUNDLE), []);
  });
});
