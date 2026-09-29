/**
 * Adversary test for ops/release-deploy.ts and ops/trust-config.ts artifactDigest (Codex code review r3 M1: "rehash
 * the exact upload set right before `vercel deploy --prebuilt`, and refuse on any difference").
 *
 * vercel@59.11.7 sends each upload as `{ file, sha, size, mode }` (dist/chunks/chunk-G3PXSXIB.js `prepareFiles`, fed by
 * `hashes`, which lstat()s every entry and keeps `stat.mode`). It also sends an EMPTY directory of the output as its own
 * entry (`readdir`: `if (res.length === 0) list.push(filePath)`, then `prepareFiles` with `sha: undefined`).
 * artifactDigest hashes neither: its lines are `path<TAB>sha256` (or link text), with no mode, and a directory only
 * contributes the files under it. So a chmod of an uploaded file, or a new empty directory in the output, after the
 * record changes what the pinned CLI sends, while the rehash is identical and deployRecorded contacts Vercel.
 *
 * The inputs are constructed here in a temporary git repo with the repo's own ignore rules. The pinned CLI's collector
 * is called through `inspectDeploymentFiles` (`vercel deploy --dry`; local, no network, no login). No deploy is made.
 *
 *   npx mocha --import=tsx tests/release-deploy-upload-mode-adversary.spec.ts
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-deploy-mode-"));
  const app = join(root, "app");
  const out = join(app, ".vercel", "output");
  const func = join(out, "functions", "robinhood.func");
  mkdirSync(join(out, "static"), { recursive: true });
  mkdirSync(func, { recursive: true });
  mkdirSync(join(app, "src"), { recursive: true });
  mkdirSync(join(app, ".next", "server", "app"), { recursive: true });
  writeFileSync(join(app, "src", "page.txt"), "reviewed source\n");
  writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
  writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
  const server = join(app, ".next", "server", "app", "page.js");
  writeFileSync(server, "module.exports = 'server page'");
  chmodSync(server, 0o644);
  writeFileSync(
    join(func, ".vc-config.json"),
    JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", filePathMap: { ".next/server/app/robinhood/page.js": ".next/server/app/page.js" } }),
  );
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
  return { root, app, out, record, server, git };
}

async function collect(app: string, out: string) {
  const cli = (await import(pinnedCliChunk())) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<Summary> } };
  return (await cli.require_dist().inspectDeploymentFiles({ path: app, prebuilt: true, vercelOutputDir: out, debug: false })).files;
}

async function tryDeploy(f: ReturnType<typeof fixture>) {
  const calls: string[][] = [];
  const run: Run = async (_cmd, args) => {
    calls.push(args);
    return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" };
  };
  const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run, git: f.git });
  return { r, calls };
}

describe("release deploy adversary: parts of the upload the rehash never binds", function () {
  this.timeout(60_000);

  it("a filePathMap source whose mode changes after the record is uploaded with the new mode, so the deploy must refuse", async () => {
    const f = fixture();
    const src = ".next/server/app/page.js";
    const before = (await collect(f.app, f.out)).find((e) => e.path === src);
    assert.ok(before?.sha, "the pinned CLI uploads the filePathMap source");

    chmodSync(f.server, 0o755); // after the record: same bytes, another mode
    const after = (await collect(f.app, f.out)).find((e) => e.path === src);
    assert.equal(after?.sha, before.sha, "precondition: same bytes");
    assert.notEqual(after?.mode, before.mode, "precondition: the mode the pinned CLI sends for the source changed");

    const { r, calls } = await tryDeploy(f);
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although ${src} now uploads with mode ${after?.mode.toString(8)}, not ${before.mode.toString(8)}`);
    assert.equal(calls.length, 0, "vercel was never run");
  });

  it("an empty directory added to the output after the record is an upload entry, so the deploy must refuse", async () => {
    const f = fixture();
    const beforePaths = (await collect(f.app, f.out)).map((e) => e.path);
    mkdirSync(join(f.out, "static", "robinhood")); // after the record
    const added = (await collect(f.app, f.out)).map((e) => e.path).filter((p) => !beforePaths.includes(p));
    assert.deepEqual(added, [".vercel/output/static/robinhood"], "precondition: the pinned CLI now sends one more entry");

    const { r, calls } = await tryDeploy(f);
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although the upload gained ${added.join(", ")}`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
