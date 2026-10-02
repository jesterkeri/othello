/**
 * Adversary probe for CI job `trust-config` (ops/trust-config.ts) rule 2: "since it nothing in CONTRACT_BUNDLE
 * changed" (header, rule 2), with a hand run's local .git in the attacker's hands (adversary brief for 55a2452).
 *
 * git checks a commit object's hash when it parses it, but reads the trees under it by id without rehashing them.
 * sealedGit() turns off replace refs and the commit-graph, not this. A loose object file stored under the deployed
 * commit's `core` tree id, whose content is HEAD's `core` tree, makes `git diff <deployed> HEAD` find no change in core/.
 * The forged object is HEAD's own tree bytes, written in git's loose format (zlib of "tree <size>\0<bytes>").
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: a forged loose tree object hides a contract-bundle change (ops/trust-config.ts changedSince)", function () {
  this.timeout(60_000);

  it("a core/ change after the deploy is still reported when the deployed commit's core tree object holds HEAD's tree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-forged-tree-"));
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
    const deployed = git("rev-parse", "HEAD").trim();
    const oldCore = git("rev-parse", "HEAD:core").trim();
    writeFileSync(join(repo, "core/actions/standard.json"), '{"rounds": 99}\n');
    git("commit", "-qam", "after the deploy: the contract bundle (core/) changes");
    const newCore = git("rev-parse", "HEAD:core").trim();
    assert.notEqual(oldCore, newCore);
    assert.ok(git("diff", "--name-only", deployed, "HEAD").includes("core/actions/standard.json"), "precondition: git lists the change");

    // the deployed commit's core tree, rewritten in place to hold HEAD's core tree (the id, and the commit, are unchanged)
    const body = execFileSync("git", ["-C", repo, "cat-file", "tree", newCore]);
    const file = join(repo, ".git/objects", oldCore.slice(0, 2), oldCore.slice(2));
    rmSync(file);
    writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body])));

    const gateFile = join(repo, "ops/trust-config.ts");
    writeFileSync(gateFile, readFileSync(gateFile, "utf8").replace(/^export const DEPLOYED_COMMIT = "[0-9a-f]{40}";$/m,
      `export const DEPLOYED_COMMIT = "${deployed}";`));
    const gate = (await import(pathToFileURL(gateFile).href)) as typeof import("../ops/trust-config.ts");
    const changed = gate.changedSince(gate.DEPLOYED_COMMIT);
    assert.ok(changed === null || changed.filter(gate.CONTRACT_BUNDLE).includes("core/actions/standard.json"),
      `rule 2 saw ${JSON.stringify(changed)}: core/actions/standard.json changed after the deployed commit and passed`);
  });
});
