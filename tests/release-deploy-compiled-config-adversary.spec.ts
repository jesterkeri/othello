/**
 * Adversary test for ops/release-deploy.ts and ops/trust-config.ts cliExtraUploads (Codex code review r3 M1: "rehash
 * the exact upload set right before `vercel deploy --prebuilt`, refuse on any difference before contacting Vercel").
 *
 * vercel@59.11.7 reads its project config at deploy time through readLocalConfig (dist/chunks/chunk-Z7JWYFOY.js
 * getLocalPathConfig): when there is no `vercel.json` or `vercel.toml` in the project dir it falls back to the
 * COMPILED config `<project>/.vercel/vercel.json`. `deploy` passes that config's `bulkRedirectsPath` to the file
 * collector (dist/commands/deploy/index.js, `nowConfig: { ...localConfig }` and inspectDeploymentFiles for --dry;
 * chunk-NSOYO6JQ.js `bulkRedirectsPath: nowConfig.bulkRedirectsPath`), and buildFileTree2 then uploads the named file.
 * `app/.vercel/` is gitignored, cliExtraUploads checks only `.vercel/routes.json`, microfrontends files and config
 * files at the top of the project dir, and artifactDigest walks only `.vercel/output` and filePathMap sources.
 *
 * The test asks the pinned CLI's own config reader and collector (local, no network, no login) what a prebuilt
 * deploy would read and upload, then runs deployRecorded with a spy runner. No deploy is made.
 *
 * Inputs are constructed here in a temporary git repo; the config and CSV bodies are labels, not from any project.
 *
 *   npx mocha --import=tsx tests/release-deploy-compiled-config-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { fakePinnedCli, reviewedProjectEnv, reviewedTarget } from "./fake-pinned-cli.ts";
import { USDG, VERCEL_CLI, artifactDigest, cliExtraUploads, writeRecord } from "../ops/trust-config.ts";

/** The globally installed Vercel CLI's dist dir, only if it is the pinned version. */
function pinnedCliDist(): string {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const pkg = join(root, "vercel", "package.json");
  assert.ok(existsSync(pkg), `vercel@${VERCEL_CLI} must be installed globally (npm i -g vercel@${VERCEL_CLI})`);
  assert.equal((JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version, VERCEL_CLI, "the global vercel is the pinned CLI");
  return join(root, "vercel", "dist", "chunks");
}

describe("release deploy adversary: the compiled config .vercel/vercel.json names a bulk redirects file", function () {
  this.timeout(60_000);

  it("app/.vercel/vercel.json + a redirects file added after the record are uploaded by the pinned CLI, so the deploy must refuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-cfg-adv-"));
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
    reviewedTarget(root); // a reviewed link before the record (Codex r4 F1)
    writeRecord(record, artifactDigest(out, app), head, null, root);

    // After the scan and record: a compiled config and the redirects file it names, both in the ignored link directory.
    writeFileSync(join(app, ".vercel", "vercel.json"), JSON.stringify({ bulkRedirectsPath: ".vercel/redirects.csv" }));
    writeFileSync(join(app, ".vercel", "redirects.csv"), "source,destination\n/robinhood,/not-the-scanned-page\n");

    // Precondition 1: the pinned CLI's own config reader (what `deploy` calls on the project dir) picks the file up.
    const dist = pinnedCliDist();
    const cfgChunk = (await import(join(dist, "chunk-GUU4Z2AQ.js"))) as { readLocalConfig(p: string): { bulkRedirectsPath?: string } | undefined };
    const localConfig = cfgChunk.readLocalConfig(app) ?? {};
    assert.equal(localConfig.bulkRedirectsPath, ".vercel/redirects.csv", "vercel@59.11.7 reads app/.vercel/vercel.json as the project config");

    // Precondition 2: its collector, given the options `deploy --prebuilt` passes, uploads the redirects file.
    const cli = (await import(join(dist, "chunk-G3PXSXIB.js"))) as { require_dist(): { inspectDeploymentFiles(o: object): Promise<{ files: { path: string }[] }> } };
    const summary = await cli.require_dist().inspectDeploymentFiles({
      path: app, prebuilt: true, vercelOutputDir: out, debug: false, bulkRedirectsPath: localConfig.bulkRedirectsPath,
    });
    const uploaded = summary.files.map((f) => f.path);
    assert.ok(uploaded.includes(".vercel/redirects.csv"), `vercel@${VERCEL_CLI} uploads [${uploaded.join(", ")}]`);

    // The defect: neither the refusal list nor the rehash sees it.
    const git: Git = {
      head: () => g("rev-parse", "HEAD").trim(),
      changed: () => g("status", "--porcelain", "--no-renames", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3)),
    };
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" };
    };
    const r = await deployRecorded({ projectEnv: reviewedProjectEnv, cli: fakePinnedCli(), target: reviewedTarget(root), root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) although the upload holds .vercel/redirects.csv via .vercel/vercel.json; cliExtraUploads found [${cliExtraUploads(app).join("; ")}]`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
