/**
 * Adversary test for ops/release-deploy.ts deployRecorded (Codex code review r3 M1: "rehash the exact upload set
 * immediately before `vercel deploy --prebuilt`, refuse on any difference").
 *
 * deployRecorded refuses a `.vercel` at the repository root, but vercel@59.11.7's findRepoRoot
 * (dist/chunks/chunk-2TSBB22D.js) walks up from the deploy cwd looking for `.vercel/repo.json` in EVERY ancestor
 * (up to the home directory) BEFORE it falls back to the git root. When `<project>/.vercel/project.json` holds no
 * projectId/orgId (absent, or the settings-only file `vercel pull` itself writes for a repo-linked project,
 * writeProjectSettings with isRepoLinked), getProjectLink falls back to that ancestor's repo.json and returns
 * `repoRoot: <ancestor>`. deploy then sets `cwd = link.repoRoot`, `vercelOutputDir = join(cwd, ".vercel/output")` and
 * hands cwd to createDeploy (dist/commands/deploy/index.js). So the CLI uploads the ancestor's output, which the release
 * never scanned or hashed, while artifactDigest of `app/.vercel/output` still matches the record.
 *
 * Inputs are constructed here in temporary directories; the pinned CLI's own link reader (skipRemoteLookup, as deploy
 * calls it) and collector (inspectDeploymentFiles) run locally. No network, no login, no deploy. 0x1111...1111 is a
 * label, not a real contract.
 *
 *   npx mocha --import=tsx tests/release-deploy-ancestor-repo-link-adversary.spec.ts
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

describe("release deploy adversary: a .vercel/repo.json above the repository root", function () {
  this.timeout(60_000);

  it("an ancestor repo link that moves the pinned CLI's upload out of app/ is refused", async () => {
    const dist = pinnedCliDist();
    const above = mkdtempSync(join(tmpdir(), "release-deploy-ancestor-"));
    const root = join(above, "othello-arb");
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app" }));
    // exactly the shape `vercel pull` 59.11.7 writes for a repo-linked project: settings only, no ids
    writeFileSync(join(app, ".vercel", "project.json"), JSON.stringify({ settings: { framework: "nextjs" } }, null, 2));

    // the parent directory holds a repo link and the output the CLI will really upload: never scanned, never hashed
    mkdirSync(join(above, ".vercel", "output", "static"), { recursive: true });
    writeFileSync(join(above, ".vercel", "repo.json"), JSON.stringify({
      orgId: "team_adversary", remoteName: "origin", projects: [{ id: "prj_adversary", name: "othello", directory: "." }],
    }));
    writeFileSync(join(above, ".vercel", "output", "config.json"), JSON.stringify({ version: 3 }));
    const evil = `0x${"11".repeat(20)}`;
    writeFileSync(join(above, ".vercel", "output", "static", "chunk.js"), `const factory = "${evil}";`);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules/\napp/node_modules/\napp/.next/\napp/.vercel/\n.vercel/\n"); // as the repo's
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "reviewed commit");
    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };
    assert.equal(existsSync(join(root, ".vercel")), false, "no .vercel at the repository root");

    // precondition 1: the pinned CLI's link reader, from app/, links through the ancestor's repo.json
    const linkMod = (await import(join(dist, "chunks", "chunk-2TSBB22D.js"))) as {
      getLinkedProject(client: object, o: object): Promise<{ status: string; repoRoot?: string; project?: { rootDirectory?: string | null } }>;
    };
    const link = await linkMod.getLinkedProject({ cwd: app, config: {} }, { cwd: app, skipRemoteLookup: true });
    assert.equal(link.status, "linked", `precondition: linked (${JSON.stringify(link)})`);
    assert.equal(link.repoRoot, above, "precondition: the CLI's link carries the ancestor as repoRoot");
    assert.equal(link.project?.rootDirectory ?? null, null, "precondition: no rootDirectory, so vercelOutputDir = <ancestor>/.vercel/output");

    // precondition 2: deploy moves cwd, output dir and collector path to repoRoot
    const deploySrc = readFileSync(join(dist, "commands", "deploy", "index.js"), "utf8");
    assert.match(deploySrc, /if \(link\.repoRoot\) \{\s*cwd = link\.repoRoot;\s*\}[\s\S]{0,400}vercelOutputDir = join4\(cwd, "\.vercel\/output"\);/);

    // precondition 3: the pinned CLI's collector, given that path, uploads the unscanned chunk
    const cli = (await import(join(dist, "chunks", "chunk-G3PXSXIB.js"))) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<Summary> } };
    const sent = (await cli.require_dist().inspectDeploymentFiles({
      path: above, prebuilt: true, vercelOutputDir: join(above, ".vercel", "output"), debug: false,
    })).files;
    const evilSha = execFileSync("sha1sum", [join(above, ".vercel", "output", "static", "chunk.js")], { encoding: "utf8" }).split(" ")[0];
    assert.ok(sent.some((f) => f.sha === evilSha), `precondition: the CLI uploads the unscanned chunk (${JSON.stringify(sent)})`);

    // a release scan that refuses this state is a fix too: the record is never written
    if (scanTree(out, null, app).length) return;
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), g("rev-parse", "HEAD").trim(), null, root);

    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" }; };
    const r = await deployRecorded({ root, recordFile: record, prod: false, run, git, env: {} });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) while the CLI would upload ${above}/.vercel/output`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
