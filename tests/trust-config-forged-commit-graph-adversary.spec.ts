/**
 * Adversary probe for CI job `trust-config` (ops/trust-config.ts) rule 2: "since it nothing in CONTRACT_BUNDLE
 * changed ..., whatever the file names, refs, or repository configuration" (adversary brief for 84043b3).
 *
 * git reads a commit's root tree from the commit-graph file (.git/objects/info/commit-graph) when one is present,
 * not from the commit object. sealedGit() turns off replace refs but not core.commitGraph. A commit-graph whose entry
 * for the deployed commit names HEAD's tree makes `git diff <deployed> HEAD` compare HEAD with itself.
 * The graph is written by git itself, then one tree id is patched and the trailing checksum recomputed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: a forged commit-graph hides a contract-bundle change (ops/trust-config.ts changedSince)", function () {
  this.timeout(60_000);

  it("a core/ change after the deploy is still reported when the commit-graph names HEAD's tree for the deployed commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-commit-graph-"));
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
    writeFileSync(join(repo, "core/actions/standard.json"), '{"rounds": 99}\n');
    git("commit", "-qam", "after the deploy: the contract bundle (core/) changes");
    const headTree = git("rev-parse", "HEAD^{tree}").trim();
    assert.ok(git("diff", "--name-only", deployed, "HEAD").includes("core/actions/standard.json"), "precondition: git lists the change");

    git("commit-graph", "write", "--reachable");
    const file = join(repo, ".git/objects/info/commit-graph");
    const g = readFileSync(file);
    assert.equal(g.subarray(0, 4).toString(), "CGPH");
    const chunks = g[6]!;
    const off: Record<string, number> = {};
    for (let i = 0; i < chunks; i++) off[g.subarray(8 + 12 * i, 12 + 12 * i).toString()] = Number(g.readBigUInt64BE(12 + 12 * i));
    const n = g.readUInt32BE(off.OIDF! + 255 * 4);
    let pos = -1;
    for (let i = 0; i < n; i++) if (g.subarray(off.OIDL! + 20 * i, off.OIDL! + 20 * (i + 1)).toString("hex") === deployed) pos = i;
    assert.ok(pos >= 0, "precondition: the deployed commit is in the graph");
    Buffer.from(headTree, "hex").copy(g, off.CDAT! + 36 * pos);
    createHash("sha1").update(g.subarray(0, g.length - 20)).digest().copy(g, g.length - 20);
    rmSync(file);
    writeFileSync(file, g);

    const gateFile = join(repo, "ops/trust-config.ts");
    writeFileSync(gateFile, readFileSync(gateFile, "utf8").replace(/^export const DEPLOYED_COMMIT = "[0-9a-f]{40}";$/m,
      `export const DEPLOYED_COMMIT = "${deployed}";`));
    const gate = (await import(pathToFileURL(gateFile).href)) as typeof import("../ops/trust-config.ts");
    const changed = gate.changedSince(gate.DEPLOYED_COMMIT);
    assert.ok(changed === null || changed.filter(gate.CONTRACT_BUNDLE).includes("core/actions/standard.json"),
      `rule 2 saw ${JSON.stringify(changed)}: core/actions/standard.json changed after the deployed commit and passed`);
  });
});
