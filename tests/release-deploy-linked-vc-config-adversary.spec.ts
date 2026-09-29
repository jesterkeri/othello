/**
 * Adversary test for ops/trust-config.ts uploadSet/artifactDigest and ops/release-deploy.ts deployRecorded (Codex code
 * review r3 M1: "rehash the exact upload set immediately before `vercel deploy --prebuilt`, and refuse on any difference").
 *
 * vercel@59.11.7 finds filePathMap configs as every entry of the output whose basename is `.vc-config.json`
 * (dist/chunks/chunk-G3PXSXIB.js buildFileTree2: `fileList.filter(basename === ".vc-config.json")`, then `readFile`).
 * Its `readdir` lstat()s entries and lists a link to a file as a file, and readFile follows the link. uploadSet's walk
 * skips every link (`if (st.isSymbolicLink()) continue;`), so a `.vc-config.json` that is a link to a config elsewhere
 * in the output is read by the CLI and its filePathMap sources are uploaded, while the digest binds only the link text
 * and the config bytes, never the source file. Changing that source after the record leaves the digest unchanged.
 *
 * The inputs are constructed here in a temporary git repo with the repo's own ignore rules. The pinned CLI's collector
 * is called through `inspectDeploymentFiles` (`vercel deploy --dry`; local, no network, no login). No deploy is made.
 *
 *   npx mocha --import=tsx tests/release-deploy-linked-vc-config-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { USDG, VERCEL_CLI, artifactDigest, scanTree, writeRecord } from "../ops/trust-config.ts";

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

describe("release deploy adversary: a .vc-config.json that is a link", () => {
  it("a filePathMap source read through a linked .vc-config.json, changed after the record, is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-linkcfg-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    const func = join(out, "functions", "robinhood.func");
    mkdirSync(join(out, "static"), { recursive: true });
    mkdirSync(func, { recursive: true });
    mkdirSync(join(app, ".next", "server", "app"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    const server = join(app, ".next", "server", "app", "page.js");
    writeFileSync(server, "module.exports = 'reviewed server page'");
    // the real config lives elsewhere in the output; the function's .vc-config.json is a link to it (inside the artifact)
    writeFileSync(
      join(out, "static", "vc.json"),
      JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", filePathMap: { ".next/server/app/robinhood/page.js": ".next/server/app/page.js" } }),
    );
    symlinkSync("../../static/vc.json", join(func, ".vc-config.json"));
    writeFileSync(join(root, ".gitignore"), "node_modules/\napp/node_modules/\napp/.next/\napp/.vercel/\n.vercel/\n"); // as the repo's
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "reviewed commit");
    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };

    // precondition: the pinned CLI uploads the filePathMap source named by the linked config
    const before = await collect(app, out);
    const src = before.find((f) => f.path === ".next/server/app/page.js");
    assert.ok(src, `precondition: the pinned CLI uploads .next/server/app/page.js (${before.map((f) => f.path).join(", ")})`);

    // a release scan that refuses this state is a fix too: the record is never written
    if (scanTree(out, null, app).length) return;
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    writeRecord(record, artifactDigest(out, app), g("rev-parse", "HEAD").trim(), null, root);

    // after the record: the uploaded source's bytes change
    writeFileSync(server, "module.exports = 'UNREVIEWED server page'");
    const after = await collect(app, out);
    assert.notEqual(after.find((f) => f.path === ".next/server/app/page.js")?.sha, src.sha, "precondition: the CLI now sends other bytes");

    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" }; };
    const r = await deployRecorded({ root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) a changed filePathMap source`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
