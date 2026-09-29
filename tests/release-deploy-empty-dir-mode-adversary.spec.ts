/**
 * Adversary test for ops/release-deploy.ts and ops/trust-config.ts artifactDigest (Codex code review r3 M1: "rehash
 * the exact upload set right before `vercel deploy --prebuilt`, and refuse on any difference").
 *
 * vercel@59.11.7 sends an EMPTY directory of the output as its own upload entry, with the mode `hashes` read by
 * lstat() (dist/chunks/chunk-G3PXSXIB.js `readdir`: `if (res.length === 0) list.push(filePath)`; `hashes`:
 * `const mode = stat.mode`). artifactDigest binds such a directory as `path/<TAB>dir`, with no mode. So a chmod of an
 * empty output directory after the record changes what the pinned CLI sends, while the rehash is identical and
 * deployRecorded contacts Vercel.
 *
 * Inputs are constructed here in a temporary git repo with the repo's own ignore rules. The pinned CLI's collector
 * is called through `inspectDeploymentFiles` (`vercel deploy --dry`; local, no network, no login). No deploy is made.
 *
 *   npx mocha --import=tsx tests/release-deploy-empty-dir-mode-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { USDG, VERCEL_CLI, artifactDigest, writeRecord } from "../ops/trust-config.ts";

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

describe("release deploy adversary: the mode of an empty output directory", function () {
  this.timeout(60_000);

  it("an empty output directory whose mode changes after the record is uploaded with the new mode, so the deploy must refuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-dirmode-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    const empty = join(out, "static", "robinhood");
    mkdirSync(empty, { recursive: true });
    chmodSync(empty, 0o755);
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src", "page.txt"), "reviewed source\n");
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    writeFileSync(join(root, ".gitignore"), "node_modules/\napp/node_modules/\napp/.next/\napp/.vercel/\n.vercel/\n"); // as the repo's
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
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

    const entry = ".vercel/output/static/robinhood";
    const before = (await collect(app, out)).find((e) => e.path === entry);
    assert.ok(before, "precondition: the pinned CLI uploads the empty directory as an entry");

    chmodSync(empty, 0o700); // after the record: same path, another mode
    const after = (await collect(app, out)).find((e) => e.path === entry);
    assert.notEqual(after?.mode, before.mode, "precondition: the mode the pinned CLI sends for the directory changed");

    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" };
    };
    const r = await deployRecorded({ root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although ${entry} now uploads with mode ${after?.mode.toString(8)}, not ${before.mode.toString(8)}`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
