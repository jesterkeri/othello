/**
 * Adversary probe for CI job `trust-config` (ops/trust-config.ts) rule 2: "Page-bundle changes (anything outside
 * CONTRACT_BUNDLE) must not fail the gate, whatever file names they use" (adversary brief for 55a2452).
 *
 * gitIn() runs git through execFileSync with Node's default output limit (1 MiB). A page-bundle commit whose changed
 * names total more than that (here 300 files under app/public, each path about 3.6 KB, within Linux's 4096-byte
 * path limit) makes `git diff --name-only` overflow it; changedSince() catches the error and returns null, and verify()
 * then reports the reviewed deployed commit as "not an ancestor of HEAD", failing a correct state.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: long page-bundle names overflow the diff output (ops/trust-config.ts changedSince)", function () {
  this.timeout(120_000);

  it("a page-bundle commit with long file names still lets rule 2 see the deployed commit as an unchanged ancestor", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-long-names-"));
    mkdirSync(join(repo, "ops"));
    mkdirSync(join(repo, "core/actions"), { recursive: true });
    cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    git("init", "-q");
    writeFileSync(join(repo, "core/actions/standard.json"), '{"rounds": 10}\n');
    git("add", "ops", "core");
    git("commit", "-qm", "stands in for the reviewed, deployed commit");
    const deployed = git("rev-parse", "HEAD").trim();

    // a page-bundle change only: 300 files under one deep folder of app/public (14 components of 250 bytes)
    const deep = join("app/public", ...Array.from({ length: 14 }, (_, i) => `${String(i).padStart(2, "0")}${"d".repeat(248)}`));
    mkdirSync(join(repo, deep), { recursive: true });
    for (let i = 0; i < 300; i++) writeFileSync(join(repo, deep, `${String(i).padStart(3, "0")}${"f".repeat(80)}.txt`), `${i}\n`);
    git("add", "app");
    git("commit", "-qm", "after the deploy: page bundle only");
    const names = git("diff", "--name-only", "-z", deployed, "HEAD", "--");
    assert.ok(names.length > 1024 * 1024, `precondition: the names total ${names.length} bytes`);

    const gateFile = join(repo, "ops/trust-config.ts");
    writeFileSync(gateFile, readFileSync(gateFile, "utf8").replace(/^export const DEPLOYED_COMMIT = "[0-9a-f]{40}";$/m,
      `export const DEPLOYED_COMMIT = "${deployed}";`));
    const gate = (await import(pathToFileURL(gateFile).href)) as typeof import("../ops/trust-config.ts");
    const changed = gate.changedSince(gate.DEPLOYED_COMMIT);
    assert.ok(changed !== null, "rule 2 called the reviewed deployed commit not an ancestor of HEAD after a page-bundle-only change");
    assert.deepEqual(changed.filter(gate.CONTRACT_BUNDLE), []);
  });
});
