/**
 * Adversary test for ops/release-deploy.ts (Codex code review r3 M1: "rehash the exact upload set right before
 * `vercel deploy --prebuilt`, refuse on any difference").
 *
 * vercel@59.11.7's own file collector for a prebuilt deploy (dist/chunks/chunk-G3PXSXIB.js, buildFileTree2) adds
 * `<project>/.vercel/routes.json` to the upload whenever that file exists, besides `.vercel/output` and the
 * filePathMap sources. `app/.vercel/` is gitignored, so `git status` never lists it, and `artifactDigest` walks only
 * `.vercel/output` and filePathMap sources, so the rehash does not see it either. The test asks the pinned CLI's own
 * collector (`inspectDeploymentFiles`, the function behind `vercel deploy --dry`; local, no network, no login) which
 * files it would upload, then runs deployRecorded with a spy runner. No deploy is made.
 *
 * Inputs are constructed here in a temporary git repo; the routes.json body is a label, not taken from any project.
 *
 *   npx mocha --import=tsx tests/release-deploy-uploads-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { USDG, VERCEL_CLI, artifactDigest, writeRecord } from "../ops/trust-config.ts";

/** The globally installed Vercel CLI, only if it is the pinned version. */
function pinnedCliChunk(): string {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const pkg = join(root, "vercel", "package.json");
  assert.ok(existsSync(pkg), `vercel@${VERCEL_CLI} must be installed globally (npm i -g vercel@${VERCEL_CLI})`);
  assert.equal((JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version, VERCEL_CLI, "the global vercel is the pinned CLI");
  return join(root, "vercel", "dist", "chunks", "chunk-G3PXSXIB.js");
}

describe("release deploy adversary: a file vercel deploy --prebuilt uploads but the rehash never reads", function () {
  this.timeout(60_000);

  it("app/.vercel/routes.json added after the record is uploaded by the pinned CLI, so the deploy must refuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-adv-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src", "page.txt"), "reviewed source\n");
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    writeFileSync(join(root, ".gitignore"), "app/.vercel/\n.vercel/\n"); // as the repo's .gitignore
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "reviewed commit");
    const head = g("rev-parse", "HEAD").trim();

    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), head, null, root);

    // After the scan and record: a routes file appears in the ignored project link directory.
    writeFileSync(join(app, ".vercel", "routes.json"), JSON.stringify({ routes: [{ src: "/robinhood", dest: "/not-the-scanned-page" }] }));

    // Precondition: the pinned CLI's own collector uploads it.
    const cli = (await import(pinnedCliChunk())) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<{ files: { path: string }[] }> } };
    const summary = await cli.require_dist().inspectDeploymentFiles({ path: app, prebuilt: true, vercelOutputDir: out, debug: false });
    const uploaded = summary.files.map((f) => f.path);
    assert.ok(uploaded.includes(".vercel/routes.json"), `vercel@${VERCEL_CLI} uploads [${uploaded.join(", ")}]`);

    // The git check exactly as ops/release-deploy.ts runs it.
    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" };
    };
    const r = await deployRecorded({ root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although the upload holds .vercel/routes.json, which the record never saw`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
