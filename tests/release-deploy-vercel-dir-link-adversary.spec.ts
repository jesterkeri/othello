/**
 * Adversary test for ops/release-deploy.ts and ops/trust-config.ts cliExtraUploads/artifactDigest (Codex code review
 * r3 M1: "rehash the exact upload set right before `vercel deploy --prebuilt`, and refuse on any difference").
 *
 * cliExtraUploads now refuses `.vercel/output` and `.vercel/node` as links, because vercel@59.11.7 uploads a link as
 * its text (dist/chunks/chunk-G3PXSXIB.js `readdir` lstat()s each entry and only descends real directories; `hashes`
 * reads a link's text). The same holds one level up: when `<project>/.vercel` itself is a link, the pinned CLI's
 * collector returns that link as the whole upload, while artifactDigest follows it (realpathSync) and binds the files
 * behind it. app/.gitignore's line `.vercel` (no slash) ignores a link too, so the clean-tree check is silent.
 * Retargeting the link after the record changes what the CLI sends, the rehash is identical, and deployRecorded runs
 * vercel.
 *
 * Inputs are constructed here in a temporary git repo with the repo's own .gitignore and app/.gitignore. The pinned CLI's collector is
 * called through `inspectDeploymentFiles` (`vercel deploy --dry`; local, no network, no login). No deploy is made.
 *
 *   npx mocha --import=tsx tests/release-deploy-vercel-dir-link-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { USDG, VERCEL_CLI, artifactDigest, writeRecord } from "../ops/trust-config.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function pinnedCliChunk(): string {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const pkg = join(root, "vercel", "package.json");
  assert.ok(existsSync(pkg), `vercel@${VERCEL_CLI} must be installed globally (npm i -g vercel@${VERCEL_CLI})`);
  assert.equal((JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version, VERCEL_CLI, "the global vercel is the pinned CLI");
  return join(root, "vercel", "dist", "chunks", "chunk-G3PXSXIB.js");
}

type Summary = { files: { path: string; sha?: string; mode: number }[] };

async function collect(app: string, out: string) {
  const cli = (await import(pinnedCliChunk())) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<Summary> } };
  return (await cli.require_dist().inspectDeploymentFiles({ path: app, prebuilt: true, vercelOutputDir: out, debug: false })).files;
}

describe("release deploy adversary: <project>/.vercel as a link", function () {
  this.timeout(60_000);

  it("a .vercel link retargeted after the record is uploaded as its new text, so the deploy must refuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-vdirlink-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "release-deploy-vdirlink-real-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src", "page.txt"), "reviewed source\n");
    // the real .vercel folder lives outside the checkout (e.g. shared between worktrees); app/.vercel links to it
    const a = join(elsewhere, "vercel-a");
    mkdirSync(join(a, "output", "static"), { recursive: true });
    writeFileSync(join(a, "project.json"), JSON.stringify({ projectId: "p", orgId: "o", settings: {} }));
    writeFileSync(join(a, "output", "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(a, "output", "static", "chunk.js"), `const usdg = "${USDG}";`);
    symlinkSync(a, join(app, ".vercel"));
    cpSync(join(REPO, ".gitignore"), join(root, ".gitignore")); // the repo's own ignore rules
    cpSync(join(REPO, "app", ".gitignore"), join(app, ".gitignore"));
    const g = (...x: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...x], { encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "reviewed commit");
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), g("rev-parse", "HEAD").trim(), null, root);
    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };
    assert.deepEqual(git.changed().filter((p) => !p.startsWith("release/")), [], "precondition: git sees no change (the repo ignores a .vercel link)");

    const before = await collect(app, out);
    assert.deepEqual(before.map((e) => e.path), [".vercel"], "precondition: the pinned CLI uploads .vercel as one entry, the link");

    // after the record: another folder with the same bytes, the link now names it
    const b = join(elsewhere, "vercel-b");
    cpSync(a, b, { recursive: true });
    rmSync(join(app, ".vercel"));
    symlinkSync(b, join(app, ".vercel"));
    const after = await collect(app, out);
    assert.notEqual(after[0]?.sha, before[0]?.sha, "precondition: what the pinned CLI sends for .vercel changed");

    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" };
    };
    const r = await deployRecorded({ root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although the CLI uploads only the link .vercel, now with other text`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
