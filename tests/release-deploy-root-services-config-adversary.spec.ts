/**
 * Adversary test for ops/release-deploy.ts deployRecorded (Codex code review r3 M1: "rehash the exact upload set
 * immediately before `vercel deploy --prebuilt`, refuse on any difference").
 *
 * deployRecorded refuses a `.vercel` at the repository root because "a repo-root .vercel can move the CLI's project root
 * (its services mode)". But vercel@59.11.7 turns services mode on from a repository-root Vercel CONFIG file too:
 * ensureLink and getLinkedProject both start with resolveProjectCwd (dist/chunks/chunk-2TSBB22D.js), whose
 * findProjectRoot stops at the first folder above app/ holding `.git`, `.vercel`, `vercel.json` or `vercel.toml` (always
 * the repository root, it has `.git`), and isExperimentalServicesEnabled (chunk-VT3Z7HF6.js) then reads that folder's
 * vercel.json / vercel.toml / vercel.ts for a `services` key. When services are detected the CLI's project root becomes
 * the repository root: app/.vercel/project.json (with both ids) is never read, the link is taken from the repository
 * root instead, and the recorded project and output are no longer what the CLI works from. deployRecorded checks
 * neither the repository root's config files nor this mode, so it runs vercel.
 *
 * Inputs are constructed here in temporary directories; the pinned CLI's own resolveProjectCwd and link reader
 * (skipRemoteLookup, nonInteractive) run locally. No network, no login, no deploy. prj_/team_ ids are labels.
 *
 *   npx mocha --import=tsx tests/release-deploy-root-services-config-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { fakePinnedCli, reviewedTarget } from "./fake-pinned-cli.ts";
import { USDG, VERCEL_CLI, artifactDigest, scanTree, writeRecord } from "../ops/trust-config.ts";

function pinnedCliDist(): string {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const pkg = join(root, "vercel", "package.json");
  assert.ok(existsSync(pkg), `vercel@${VERCEL_CLI} must be installed globally (npm i -g vercel@${VERCEL_CLI})`);
  assert.equal((JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version, VERCEL_CLI, "the global vercel is the pinned CLI");
  return join(root, "vercel", "dist");
}

describe("release deploy adversary: a services config at the repository root", function () {
  this.timeout(60_000);

  it("a committed repository-root vercel.json that moves the pinned CLI's project root out of app/ is refused", async () => {
    const dist = pinnedCliDist();
    const root = mkdtempSync(join(tmpdir(), "release-deploy-root-services-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app" }));
    // exactly the shape `vercel pull` 59.11.7 writes for an ordinary (folder-linked) project: both ids present
    writeFileSync(join(app, ".vercel", "project.json"), JSON.stringify({
      projectId: "prj_recorded", orgId: "team_recorded", projectName: "othello", settings: { framework: "nextjs" },
    }, null, 2));

    // the reviewed commit carries a repository-root vercel.json with a services block; no .vercel anywhere above app/
    writeFileSync(join(root, "vercel.json"), JSON.stringify({ services: { web: { root: "app" } } }));
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

    // precondition: the pinned CLI, started in app/, takes the repository root as its project root and never reads
    // app/.vercel/project.json (a plain folder link with both ids)
    const linkMod = (await import(join(dist, "chunks", "chunk-2TSBB22D.js"))) as {
      resolveProjectCwd(cwd: string): Promise<string>;
      getLinkedProject(client: object, o: object): Promise<{ status: string; project?: { id?: string } | null }>;
    };
    assert.equal(await linkMod.resolveProjectCwd(app), root, "precondition: the CLI's project root is the repository root");
    const link = await linkMod.getLinkedProject({ cwd: app, config: {}, nonInteractive: true }, { cwd: app, skipRemoteLookup: true });
    assert.notEqual(link.project?.id, "prj_recorded", `precondition: the CLI ignores app's recorded link (${JSON.stringify(link)})`);

    // a release scan that refuses this state is a fix too: the record is never written
    if (scanTree(out, null, app).length) return;
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    reviewedTarget(root); // a reviewed link before the record (Codex r4 F1)
    writeRecord(record, artifactDigest(out, app), g("rev-parse", "HEAD").trim(), null, root);

    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" }; };
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(root), root, recordFile: record, prod: false, run, git, env: {} });
    assert.equal(r.ok, false, `deployRecorded ran vercel (${JSON.stringify(r)}) although the pinned CLI works from ${root}, not app/`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
