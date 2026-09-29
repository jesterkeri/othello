/**
 * Adversary test for ops/trust-config.ts cliExtraUploads and ops/release-deploy.ts deployRecorded (Codex code review r3
 * M1: "rehash the exact upload set immediately before `vercel deploy --prebuilt`, refuse on any difference").
 *
 * vercel@59.11.7 reads `<project>/.vercel/project.json` through getLinkFromDir (dist/chunks/chunk-2TSBB22D.js), whose
 * schema requires only projectId and orgId and keeps every other field. getLinkedProject returns the file's `repoRoot`
 * as the link's repoRoot, and deploy then does `if (link.repoRoot) { cwd = link.repoRoot; }`, sets
 * `vercelOutputDir = join(cwd, ".vercel/output")` and hands that cwd to createDeploy as the collector's path (dist/commands/deploy/index.js).
 * So a project.json with a `repoRoot` makes the pinned CLI upload ANOTHER directory's output, while cliExtraUploads
 * refuses only `settings.rootDirectory` and artifactDigest rehashes `app/.vercel/output`. The `/project:` digest line
 * binds the file's bytes, so this is about a record-time state: the scan passes, the record is written, the rehash
 * matches, and the deploy uploads bytes that were never scanned or hashed.
 *
 * Inputs are constructed here in a temporary git repo with the repo's own ignore rules. The pinned CLI's own link
 * reader (skipRemoteLookup, local) and collector (inspectDeploymentFiles, local) are called; no network, no login, no
 * deploy. The address 0x1111...1111 is a label, not any real contract.
 *
 *   npx mocha --import=tsx tests/release-deploy-project-json-repo-root-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { USDG, VERCEL_CLI, artifactDigest, scanTree, writeRecord } from "../ops/trust-config.ts";

function pinnedCliDist(): string {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const pkg = join(root, "vercel", "package.json");
  assert.ok(existsSync(pkg), `vercel@${VERCEL_CLI} must be installed globally (npm i -g vercel@${VERCEL_CLI})`);
  assert.equal((JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version, VERCEL_CLI, "the global vercel is the pinned CLI");
  return join(root, "vercel", "dist");
}

type Summary = { files: { path: string; sha?: string; mode: number }[] };

describe("release deploy adversary: .vercel/project.json names a repoRoot", function () {
  this.timeout(60_000);

  it("a project.json repoRoot that moves the pinned CLI's upload to another directory is refused", async () => {
    const dist = pinnedCliDist();
    const root = mkdtempSync(join(tmpdir(), "release-deploy-reporoot-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app" }));

    // the directory the CLI will really upload: never scanned, never hashed
    const other = mkdtempSync(join(tmpdir(), "release-deploy-reporoot-other-"));
    mkdirSync(join(other, ".vercel", "output", "static"), { recursive: true });
    writeFileSync(join(other, ".vercel", "output", "config.json"), JSON.stringify({ version: 3 }));
    const evil = `0x${"11".repeat(20)}`;
    writeFileSync(join(other, ".vercel", "output", "static", "chunk.js"), `const factory = "${evil}";`);

    writeFileSync(
      join(app, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_adversary", orgId: "team_adversary", projectName: "othello", settings: {}, repoRoot: other }),
    );
    writeFileSync(join(root, ".gitignore"), "node_modules/\napp/node_modules/\napp/.next/\napp/.vercel/\n.vercel/\n"); // as the repo's
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "reviewed commit");
    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };

    // precondition 1: the pinned CLI's own link reader takes repoRoot from project.json (local, skipRemoteLookup as deploy does)
    const linkMod = (await import(join(dist, "chunks", "chunk-2TSBB22D.js"))) as {
      getLinkedProject(client: object, o: object): Promise<{ status: string; repoRoot?: string }>;
    };
    const link = await linkMod.getLinkedProject({ cwd: app, config: {} }, { cwd: app, skipRemoteLookup: true });
    assert.equal(link.status, "linked", `precondition: linked (${JSON.stringify(link)})`);
    assert.equal(link.repoRoot, other, "precondition: the CLI's link carries project.json's repoRoot");

    // precondition 2: deploy moves its cwd, output dir and collector path to that repoRoot
    const deploySrc = readFileSync(join(dist, "commands", "deploy", "index.js"), "utf8");
    assert.match(deploySrc, /if \(link\.repoRoot\) \{\s*cwd = link\.repoRoot;\s*\}[\s\S]{0,400}vercelOutputDir = join4\(cwd, "\.vercel\/output"\);/);
    assert.match(deploySrc, /deployment = await createDeploy\(\s*client,\s*now,\s*contextName,\s*cwd,/);

    // precondition 3: the pinned CLI's collector, given that path, uploads the other directory's bytes
    const cli = (await import(join(dist, "chunks", "chunk-G3PXSXIB.js"))) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<Summary> } };
    const sent = (await cli.require_dist().inspectDeploymentFiles({
      path: other, prebuilt: true, vercelOutputDir: join(other, ".vercel", "output"), debug: false,
    })).files;
    const evilSha = execFileSync("sha1sum", [join(other, ".vercel", "output", "static", "chunk.js")], { encoding: "utf8" }).split(" ")[0];
    assert.ok(sent.some((f) => f.sha === evilSha), `precondition: the CLI uploads the unscanned chunk (${JSON.stringify(sent)})`);

    // a release scan that refuses this state is a fix too: the record is never written
    if (scanTree(out, null, app).length) return;
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), g("rev-parse", "HEAD").trim(), null, root);

    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" }; };
    const r = await deployRecorded({ root, recordFile: record, prod: false, run, git, env: {} });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) while project.json points the CLI at ${other}`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
