/**
 * Adversary test for ops/release-deploy.ts and ops/trust-config.ts artifactDigest (Codex code review r3 M1: "rehash
 * the exact upload set right before `vercel deploy --prebuilt`, refuse on any difference").
 *
 * A pnpm package link in a function's filePathMap (`node_modules/<pkg>` -> `.pnpm/<pkg>@<v>/node_modules/<pkg>`) is
 * a symbolic link to a folder. vercel@59.11.7's collector (dist/chunks/chunk-G3PXSXIB.js, `hashes`) lstat()s every
 * upload and sends a link as its link TEXT. uploadSet/artifactDigest record such a folder link only as
 * `upload:<key>\t-> <realpath relative to the project>`, never its link text (the text is bound only for FILE links).
 * So re-writing the link text after the record, to a form that resolves to the same folder locally, changes the
 * bytes Vercel receives while the rehash is identical, and deployRecorded contacts Vercel.
 *
 * The inputs are constructed here in a temporary git repo with the repo's own ignore rules; the package body is a
 * label. The pinned CLI's collector is called through `inspectDeploymentFiles` (`vercel deploy --dry`; local, no
 * network, no login). No deploy is made.
 *
 *   npx mocha --import=tsx tests/release-deploy-dir-link-text-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { fakePinnedCli } from "./fake-pinned-cli.ts";
import { USDG, VERCEL_CLI, artifactDigest, writeRecord } from "../ops/trust-config.ts";

function pinnedCliChunk(): string {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const pkg = join(root, "vercel", "package.json");
  assert.ok(existsSync(pkg), `vercel@${VERCEL_CLI} must be installed globally (npm i -g vercel@${VERCEL_CLI})`);
  assert.equal((JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version, VERCEL_CLI, "the global vercel is the pinned CLI");
  return join(root, "vercel", "dist", "chunks", "chunk-G3PXSXIB.js");
}

type Summary = { files: { path: string; sha?: string; mode: number }[] };

describe("release deploy adversary: a filePathMap folder link is uploaded as its text, which the rehash never binds", function () {
  this.timeout(60_000);

  it("re-writing a package link's text after the record changes the upload, so the deploy must refuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-dirlink-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    const func = join(out, "functions", "robinhood.func");
    mkdirSync(join(out, "static"), { recursive: true });
    mkdirSync(func, { recursive: true });
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src", "page.txt"), "reviewed source\n");
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    // a pnpm layout: node_modules/pkg is a link to its folder in the store
    const store = join(app, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "index.js"), "module.exports = 'pkg';");
    const link = join(app, "node_modules", "pkg");
    symlinkSync(".pnpm/pkg@1.0.0/node_modules/pkg", link);
    writeFileSync(
      join(func, ".vc-config.json"),
      JSON.stringify({
        runtime: "nodejs22.x", handler: "index.js",
        filePathMap: {
          "node_modules/pkg": "node_modules/pkg",
          "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js": "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js",
        },
      }),
    );
    writeFileSync(join(root, ".gitignore"), "node_modules/\napp/node_modules/\napp/.vercel/\n.vercel/\n"); // as the repo's
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "reviewed commit");
    const head = g("rev-parse", "HEAD").trim();

    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), head, null, root);

    const cli = (await import(pinnedCliChunk())) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<Summary> } };
    const collect = async () =>
      (await cli.require_dist().inspectDeploymentFiles({ path: app, prebuilt: true, vercelOutputDir: out, debug: false })).files
        .find((f) => f.path === "node_modules/pkg");
    const before = await collect();
    assert.ok(before?.sha, "the pinned CLI uploads node_modules/pkg");

    // After the record: the link is re-written to another text for the same folder.
    const real = realpathSync(store);
    rmSync(link);
    symlinkSync(real, link);
    const after = await collect();
    assert.notEqual(after?.sha, before.sha, "precondition: the bytes the pinned CLI uploads for node_modules/pkg changed");

    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" };
    };
    const r = await deployRecorded({ cli: fakePinnedCli(), root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although node_modules/pkg now uploads link text the record never saw`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
