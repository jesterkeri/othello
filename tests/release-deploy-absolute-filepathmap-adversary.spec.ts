/**
 * Adversary test for ops/trust-config.ts uploadSet/artifactDigest and ops/release-deploy.ts (Codex code review r3 M1:
 * "rehash the exact upload set right before `vercel deploy --prebuilt`, refuse on any difference").
 *
 * uploadSet resolves a function's `.vc-config.json` filePathMap source with `resolve(projectDir, v)`. vercel@59.11.7's
 * collector (dist/chunks/chunk-G3PXSXIB.js buildFileTree2) uses `join(path, v)` instead. For an ABSOLUTE source the
 * two differ: resolve gives `v` itself, join gives `<app>/<v>`. So the release hashes and scans one file while the
 * pinned CLI uploads another, which can sit under a gitignored `node_modules/` inside app/ and change after the record.
 *
 * The test asks the pinned CLI's own collector (`inspectDeploymentFiles`, the function behind `vercel deploy --dry`;
 * local, no network, no login) which files it would upload, then runs deployRecorded with a spy runner. No deploy.
 *
 * Inputs are constructed here in a temporary git repo; file bodies are labels, not taken from any project.
 *
 *   npx mocha --import=tsx tests/release-deploy-absolute-filepathmap-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

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

describe("release deploy adversary: an absolute filePathMap source", function () {
  this.timeout(60_000);

  it("the pinned CLI uploads <app>/<v>, the rehash reads <v>; a change to the uploaded file after the record must refuse", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "release-deploy-abs-adv-")));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src", "page.txt"), "reviewed source\n");
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);

    // what the rehash reads: an absolute source inside app/node_modules
    const scanned = join(app, "node_modules", "pkg", "index.js");
    mkdirSync(dirname(scanned), { recursive: true });
    writeFileSync(scanned, "module.exports = 'scanned';\n");
    // what the CLI uploads for the same entry: <app>/<absolute source>, also under an ignored node_modules/
    const uploaded = join(app, scanned);
    mkdirSync(dirname(uploaded), { recursive: true });
    writeFileSync(uploaded, "module.exports = 'scanned';\n");
    const fn = join(out, "functions", "api.func");
    mkdirSync(fn, { recursive: true });
    writeFileSync(join(fn, ".vc-config.json"), JSON.stringify({ runtime: "nodejs20.x", handler: "index.js", filePathMap: { "node_modules/pkg/index.js": scanned } }));

    writeFileSync(join(root, ".gitignore"), "node_modules/\napp/.vercel/\n.vercel/\n"); // as the repo's .gitignore
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "reviewed commit");
    const head = g("rev-parse", "HEAD").trim();

    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), head, null, root);

    // After the record: the file the CLI uploads for that entry changes (gitignored, so git status is clean).
    writeFileSync(uploaded, `module.exports = "0x1111111111111111111111111111111111111111";\n`);

    // Precondition: the pinned CLI's own collector uploads <app>/<absolute source>, not the file the rehash read.
    const cli = (await import(pinnedCliChunk())) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<{ files: { path: string }[] }> } };
    const summary = await cli.require_dist().inspectDeploymentFiles({ path: app, prebuilt: true, vercelOutputDir: out, debug: false });
    const paths = summary.files.map((f) => f.path);
    const uploadedRel = relative(app, uploaded).split("\\").join("/");
    assert.ok(paths.includes(uploadedRel), `vercel@${VERCEL_CLI} uploads [${paths.join(", ")}]`);
    assert.ok(!paths.includes("node_modules/pkg/index.js"), "and not the file the rehash read");

    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };
    assert.deepEqual(git.changed().filter((p) => !p.startsWith("release/")), [], "git sees no change");
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" };
    };
    const r = await deployRecorded({ cli: fakePinnedCli(), root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although ${uploadedRel}, which the CLI uploads, changed after the record`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
