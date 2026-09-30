/**
 * The release deploy step (ops/release-deploy.ts, Codex code review r3 M1): Vercel is contacted only when the upload
 * set still equals the recorded scan, with the pinned CLI, and the record gets a DEPLOY_URL only if nothing changed during
 * the upload. The artifact is a small hand-made prebuilt output of the shape vercel@59.11.7 writes: a static file plus
 * a function whose `.vc-config.json` filePathMap uploads a server file from the project directory. No network.
 *
 *   npx mocha --import=tsx tests/release-deploy.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ancestorRefusals, deployEnv, deployRecorded, execPinnedCli, installPinnedCli, preflight, releaseTargetRefusals, verifyPinnedCli, type Git, type Run } from "../ops/release-deploy.ts";
import { commitTarget, fakePinnedCli, reviewedTarget } from "./fake-pinned-cli.ts";
import { VERCEL_CLI, VERCEL_CLI_INTEGRITY, artifactDigest, esc, scanTree, writeRecord, type ReleaseRecord } from "../ops/trust-config.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DEPLOY_URL = "https://othello-abc123-jesterkeri.vercel.app";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-deploy-"));
  const app = join(root, "app");
  const out = join(app, ".vercel", "output");
  mkdirSync(join(out, "static"), { recursive: true });
  mkdirSync(join(out, "functions", "robinhood.func"), { recursive: true });
  mkdirSync(join(app, ".next", "server", "app"), { recursive: true });
  writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
  writeFileSync(join(out, "static", "chunk.js"), "console.log('client chunk')");
  writeFileSync(
    join(out, "functions", "robinhood.func", ".vc-config.json"),
    JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", filePathMap: { ".next/server/app/robinhood/page.js": ".next/server/app/page.js" } }),
  );
  writeFileSync(join(app, ".next", "server", "app", "page.js"), "module.exports = 'server page'");
  mkdirSync(join(root, "release"));
  const record = join(root, "release", "robinhood-prebuilt.json");
  reviewedTarget(root); // a reviewed link before the record (Codex r4 F1)
  writeRecord(record, artifactDigest(out, app), COMMIT, null, root);
  return { root, app, out, record, server: join(app, ".next", "server", "app", "page.js") };
}

const cleanGit = (changed: string[] = ["release/robinhood-prebuilt.json", "release/robinhood-prebuilt.files.txt"]): Git => ({
  head: () => COMMIT,
  changed: () => changed,
});

function spyRun(onRun?: () => void, stdout = `Vercel CLI ${VERCEL_CLI}\n${DEPLOY_URL}\n`, code = 0) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const run: Run = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    onRun?.();
    return { code, stdout };
  };
  return { run, calls };
}

const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as ReleaseRecord;

describe("release deploy: only the recorded bytes, with the pinned CLI", () => {
  it("an uploaded server file changed after the record is refused before Vercel is contacted (r3 M1)", async () => {
    const f = fixture();
    writeFileSync(f.server, "module.exports = 'server page with 0x1111111111111111111111111111111111111111'");
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /changed after it was scanned; nothing was deployed[\s\S]*upload:\.next\/server\/app\/robinhood\/page\.js/);
    assert.equal(spy.calls.length, 0, "vercel was never run");
    assert.equal(read(f.record).deploymentUrl, null);
  });

  it("a changed or added output file is refused the same way", async () => {
    const f = fixture();
    writeFileSync(join(f.out, "static", "extra.js"), "late");
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /\+ static\/extra\.js/);
    assert.equal(spy.calls.length, 0);
  });

  it("an unchanged artifact deploys with the pinned CLI from app/, and the URL goes into the record", async () => {
    const f = fixture();
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.deepEqual(r, { ok: true, url: DEPLOY_URL });
    assert.deepEqual(spy.calls, [{ cmd: process.execPath, args: [fakePinnedCli(), "deploy", "--prebuilt"], cwd: f.app }]);
    const rec = read(f.record);
    assert.equal(rec.deploymentUrl, DEPLOY_URL);
    assert.equal(rec.target, "preview");
    assert.equal(rec.vercelCli, VERCEL_CLI);
    assert.equal(rec.commit, COMMIT);
  });

  it("--prod passes --prod and records production", async () => {
    const f = fixture();
    const spy = spyRun();
    await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: true, run: spy.run, git: cleanGit() });
    assert.deepEqual(spy.calls[0]!.args.slice(-1), ["--prod"]);
    assert.equal(read(f.record).target, "production");
  });

  it("a file changed during the upload voids the deployment: no URL recorded, told not to use it", async () => {
    const f = fixture();
    const spy = spyRun(() => writeFileSync(f.server, "rebuilt by next build during the upload"));
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", new RegExp(`changed while they were uploading, so ${DEPLOY_URL.replace(/\./g, "\\.")} may not be the scanned artifact; do not use or share it`));
    assert.equal(read(f.record).deploymentUrl, null);
    assert.equal(read(f.record).voidedDeploymentUrl, DEPLOY_URL, "the voided deployment is named in the record, to remove it");
    assert.equal(existsSync(`${f.record}.writing`), false, "the record is replaced whole");
  });

  it("refuses a record already deployed, another commit, other changed files, or a record built with another CLI", async () => {
    const f = fixture();
    const spy = spyRun();
    const go = (git: Git) => deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git });

    assert.match(await go({ head: () => "f".repeat(40), changed: () => [] }).then((r) => (!r.ok ? r.reason : "")), /the checkout is f+, but the record was built from 0123/);
    assert.match(await go(cleanGit(["release/robinhood-prebuilt.json", "app/src/app/robinhood/page.tsx"])).then((r) => (!r.ok ? r.reason : "")),
      /files changed since the record was written: app\/src\/app\/robinhood\/page\.tsx/);

    const rec = read(f.record);
    writeFileSync(f.record, JSON.stringify({ ...rec, vercelCli: "60.0.0" }));
    assert.match(await go(cleanGit()).then((r) => (!r.ok ? r.reason : "")), /built with Vercel CLI 60\.0\.0; this deploy pins 59\.11\.7/);

    writeFileSync(f.record, JSON.stringify({ ...rec, deploymentUrl: DEPLOY_URL }));
    assert.match(await go(cleanGit()).then((r) => (!r.ok ? r.reason : "")), /already deployed/);
    assert.equal(spy.calls.length, 0);
  });

  it("files the CLI uploads besides the output and filePathMap (routes.json, microfrontends, Vercel config) are refused", async () => {
    for (const [rel, body] of [
      [".vercel/routes.json", "{\"routes\":[]}"],
      ["microfrontends.json", "{\"applications\":{}}"],
      ["src/deep/microfrontends.jsonc", "{}"],
      ["vercel.json", "{\"bulkRedirectsPath\":\"redirects.csv\"}"],
      [".vercel/vercel.json", "{\"bulkRedirectsPath\":\".vercel/r.csv\"}"], // the compiled config the CLI falls back to
      [".vercel/r.csv", "a,b"],
      [".vercel/node/other.json", "{}"], // only the build's package-manifest.json may sit there
      ["vercel.toml", "bulkRedirectsPath = 'r.csv'"],
      ["vercel.cts", "export default {}"],
    ] as const) {
      const f = fixture();
      mkdirSync(join(f.app, rel, ".."), { recursive: true });
      writeFileSync(join(f.app, rel), body);
      const spy = spyRun();
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", new RegExp(`scan never covered[\\s\\S]*${rel.replace(/\./g, "\\.")}: vercel deploy --prebuilt`), rel);
      assert.equal(spy.calls.length, 0, `${rel}: vercel was never run`);
    }
  });

  it("project.json: a rootDirectory is refused, a change after the record is refused, an env file from pull is allowed", async () => {
    const withProject = (settings: object) => {
      const f = fixture();
      writeFileSync(join(f.app, ".vercel", "project.json"), JSON.stringify({ projectId: "p", orgId: "o", settings }));
      writeFileSync(join(f.app, ".vercel", ".env.preview.local"), "NOT_READ=1\n"); // vercel pull writes one; only its name is checked
      reviewedTarget(f.root); // a reviewed link before the record (Codex r4 F1)
      writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root);
      return f;
    };
    const ok = withProject({ framework: "nextjs", rootDirectory: null });
    assert.equal((await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(ok.root), root: ok.root, recordFile: ok.record, prod: false, run: spyRun().run, git: cleanGit() })).ok, true);

    const rd = withProject({ framework: "nextjs", rootDirectory: "node_modules/x" });
    const spy = spyRun();
    const r1 = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(rd.root), root: rd.root, recordFile: rd.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r1.ok ? r1.reason : "", /settings\.rootDirectory "node_modules\/x"/);

    const changed = withProject({ framework: "nextjs", rootDirectory: null });
    writeFileSync(join(changed.app, ".vercel", "project.json"), JSON.stringify({ projectId: "other", orgId: "o", settings: { framework: "nextjs" } }));
    const r2 = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(changed.root), root: changed.root, recordFile: changed.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r2.ok ? r2.reason : "", /changed after it was scanned[\s\S]*project:\.vercel\/project\.json/);
    assert.equal(spy.calls.length, 0);
  });

  it("a routes.json written during the upload voids the deployment; in production the message says roll back", async () => {
    for (const prod of [false, true]) {
      const f = fixture();
      const spy = spyRun(() => writeFileSync(join(f.app, ".vercel", "routes.json"), "{}"));
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", prod ? /already live in production: roll back now/ : /do not use or share it/);
      assert.equal(read(f.record).deploymentUrl, null);
    }
  });

  it("only one https://<deployment>.vercel.app line on stdout is taken as the URL", async () => {
    for (const out of ["https://evil.example.com\n", `${DEPLOY_URL}\nhttps://othello-other-jesterkeri.vercel.app\n`, "https://othello.vercel.app/path\n"]) {
      const f = fixture();
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spyRun(undefined, out).run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", /vercel deploy failed/, out);
      assert.equal(read(f.record).deploymentUrl, null);
    }
    const f = fixture();
    const ok = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spyRun(undefined, `Inspect: x\n${DEPLOY_URL}\n${DEPLOY_URL}\n`).run, git: cleanGit() });
    assert.deepEqual(ok, { ok: true, url: DEPLOY_URL });
  });

  it("a failed deploy or one that prints no URL leaves the record unchanged", async () => {
    for (const spy of [spyRun(undefined, "", 1), spyRun(undefined, "Error: not logged in\n", 0)]) {
      const f = fixture();
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", /vercel deploy failed/);
      assert.equal(read(f.record).deploymentUrl, null);
    }
  });

  it("an environment that re-targets the CLI is refused, and the CLI gets no VERCEL_* switch", async () => {
    for (const k of ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"]) {
      const f = fixture();
      const spy = spyRun();
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit(), env: { [k]: "prj_other" } });
      assert.match(!r.ok ? r.reason : "", new RegExp(`${k} set in the environment would deploy to another project`));
      assert.equal(spy.calls.length, 0);
    }
    const env = deployEnv({ PATH: "/bin", HOME: "/h", VERCEL_USE_EXPERIMENTAL_SERVICES: "1", VERCEL_PROJECT_ID: "x", VERCEL_TOKEN: "t", SECRET: "s" });
    assert.deepEqual(env, { VERCEL_TELEMETRY_DISABLED: "1", PATH: "/bin", HOME: "/h" });
    assert.match(readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8"), /for v in VERCEL_ORG_ID VERCEL_PROJECT_ID VERCEL_TEAM_ID/);
  });

  it("a linked filePathMap source is bound by its link text as well as its bytes", async () => {
    const f = fixture();
    const target = join(f.app, ".next", "server", "app", "page-a.js");
    writeFileSync(target, "module.exports = 'server page'"); // same bytes as page.js
    rmSync(f.server);
    symlinkSync("page-a.js", f.server);
    reviewedTarget(f.root); // a reviewed link before the record (Codex r4 F1)
    writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root);
    // re-point the link to another file with identical bytes: the upload's link text changes, so the deploy refuses
    writeFileSync(join(f.app, ".next", "server", "app", "page-b.js"), "module.exports = 'server page'");
    rmSync(f.server);
    symlinkSync("page-b.js", f.server);
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /changed after it was scanned[\s\S]*-> page-b\.js/);
    assert.equal(spy.calls.length, 0);
  });

  it("a plain source and a linked source reaching the same file are two entries; the link's text is bound", async () => {
    const f = fixture();
    const cfg = join(f.out, "functions", "robinhood.func", ".vc-config.json");
    symlinkSync("page.js", join(f.app, ".next", "server", "app", "page-link.js"));
    writeFileSync(cfg, JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", filePathMap: {
      "a.js": ".next/server/app/page.js", "b.js": ".next/server/app/page-link.js",
    } }));
    reviewedTarget(f.root); // a reviewed link before the record (Codex r4 F1)
    writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root);
    rmSync(join(f.app, ".next", "server", "app", "page-link.js"));
    symlinkSync("./page.js", join(f.app, ".next", "server", "app", "page-link.js")); // same target, other text
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /changed after it was scanned[\s\S]*upload:b\.js/);
    assert.equal(spy.calls.length, 0);
  });

  it("a special file (FIFO) in the output is refused by the scan and never read by the digest", async () => {
    const f = fixture();
    execFileSync("mkfifo", [join(f.out, "static", "pipe")]);
    assert.match(scanTree(f.out, null, f.app).join("\n"), /static\/pipe: not a regular file/);
    assert.ok(artifactDigest(f.out, f.app).lines.some((l) => /^static\/pipe\tspecial 1\d+$/.test(l)), "listed, not read (no hang)");
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spyRun().run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /changed after it was scanned[\s\S]*static\/pipe/);
  });

  it("app/.vercel/output replaced by a link to a copy is refused (the CLI would upload the link, not the files)", async () => {
    const f = fixture();
    const copy = join(f.root, "output-copy");
    execFileSync("cp", ["-a", f.out, copy]);
    rmSync(f.out, { recursive: true });
    symlinkSync(copy, f.out);
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /\.vercel\/output \(a link, not a folder\)/);
    assert.equal(spy.calls.length, 0);
  });

  it("a linked app/.vercel, or a name with a tab or line break, is refused", async () => {
    const f = fixture();
    const moved = join(f.root, "vercel-real");
    execFileSync("mv", [join(f.app, ".vercel"), moved]);
    symlinkSync(moved, join(f.app, ".vercel"));
    const r1 = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spyRun().run, git: cleanGit() });
    assert.match(!r1.ok ? r1.reason : "", /\.vercel \(a link, not a folder\)/);

    const g = fixture();
    writeFileSync(join(g.out, "static", "a\tb.js"), "x");
    const spy = spyRun();
    const r2 = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(g.root), root: g.root, recordFile: g.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r2.ok ? r2.reason : "", /a tab or line break in a name/);
    assert.equal(spy.calls.length, 0);
  });

  it("digest fields are escaped: no name can carry a raw tab or line break into a line", () => {
    const samples = ["a\tb", "a\\x09b", "x\ny", "x\\ny", "c\\d", "plain/path.js", "\u0007", "\u007f"];
    const out = samples.map(esc);
    assert.equal(new Set(out).size, samples.length, "distinct names stay distinct");
    for (const o of out) assert.doesNotMatch(o, /[\u0000-\u001f\u007f]/, `${JSON.stringify(o)} has no raw control character`);
    assert.equal(esc("plain/path.js"), "plain/path.js", "ordinary names are unchanged");
  });

  it("an output file named like an upload line cannot stand in for it", () => {
    const f = fixture();
    const real = artifactDigest(f.out, f.app).lines.filter((l) => l.includes("upload:"));
    assert.ok(real.length > 0 && real.every((l) => l.startsWith("/upload:")), "upload lines start with /, which no output path can");
    writeFileSync(join(f.out, "upload:.next"), "x"); // a root output file whose name imitates the prefix
    const lines = artifactDigest(f.out, f.app).lines;
    assert.ok(lines.some((l) => l.startsWith("upload:.next\t")), "it is an output line of its own");
    assert.equal(lines.filter((l) => l.startsWith("/upload:")).length, real.length);
  });

  it("project.json keys beyond what vercel pull writes, and a repo-root .vercel, are refused", async () => {
    for (const extra of [{ repoRoot: "/tmp/elsewhere" }, { projectRootDirectory: "sub" }]) {
      const f = fixture();
      writeFileSync(join(f.app, ".vercel", "project.json"), JSON.stringify({ projectId: "p", orgId: "o", settings: {}, ...extra }));
      reviewedTarget(f.root); // a reviewed link before the record (Codex r4 F1)
      writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root); // present when recorded
      const spy = spyRun();
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", new RegExp(`project\\.json key "${Object.keys(extra)[0]}"`));
      assert.equal(spy.calls.length, 0);
    }
    const g = fixture();
    mkdirSync(join(g.root, ".vercel"));
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(g.root), root: g.root, recordFile: g.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /\.vercel at the repository root/);
    assert.equal(spy.calls.length, 0);
    assert.match(readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8"), /if \[ -e \.vercel \]/);
  });

  it("a project.json without ids, or a repo link in a folder above the app, is refused", async () => {
    const f = fixture();
    writeFileSync(join(f.app, ".vercel", "project.json"), JSON.stringify({ settings: { framework: "nextjs" } }));
    reviewedTarget(f.root); // a reviewed link before the record (Codex r4 F1)
    writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root);
    const r1 = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spyRun().run, git: cleanGit() });
    assert.match(!r1.ok ? r1.reason : "", /project\.json without projectId[\s\S]*project\.json without orgId/);

    const g = fixture();
    // a repo link one level above the repository (the CLI walks up from app/)
    const parent = mkdtempSync(join(tmpdir(), "release-deploy-parent-"));
    const nested = join(parent, "repo");
    execFileSync("cp", ["-a", g.root, nested]);
    mkdirSync(join(parent, ".vercel"));
    writeFileSync(join(parent, ".vercel", "repo.json"), JSON.stringify({ orgId: "o", projects: [{ id: "p", name: "x", directory: "." }] }));
    const spy = spyRun();
    const r2 = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(nested), root: nested, recordFile: join(nested, "release", "robinhood-prebuilt.json"), prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r2.ok ? r2.reason : "", /repo\.json \(a repo link above the project\)/);
    assert.equal(spy.calls.length, 0);
  });

  it("a Vercel config at the repository root, or a local Vercel CLI, is refused", async () => {
    for (const [rel, body] of [["vercel.json", "{\"services\":{\"web\":{\"root\":\"app\"}}}"], ["vercel.ts", "export default {}"], ["Vercel.toml", ""]] as const) {
      const f = fixture();
      writeFileSync(join(f.root, rel), body);
      const spy = spyRun();
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", new RegExp(`${rel.replace(".", "\\.")} at the repository root`), rel);
      assert.equal(spy.calls.length, 0);
    }
    for (const rel of ["node_modules/vercel", "app/node_modules/.bin/vercel"]) {
      const f = fixture();
      mkdirSync(join(f.root, rel), { recursive: true });
      const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spyRun().run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", /a local Vercel CLI that npx would run/, rel);
    }
    const script = readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8");
    assert.match(script, /for f in vercel\.\* now\.\*/);
    assert.match(script, /node_modules\/\.bin\/vercel/);
  });

  it("the record says a deploy started before Vercel is contacted; a started record is not deployed again", async () => {
    const f = fixture();
    let seen: ReleaseRecord | undefined;
    const spy = spyRun(() => { seen = read(f.record); }, "", 1); // the CLI dies without a URL
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: true, run: spy.run, git: cleanGit() });
    assert.equal(r.ok, false);
    assert.ok(seen?.deployStartedAt, "written before the CLI ran");
    assert.equal(seen?.target, "production");
    assert.equal(seen?.deploymentUrl, null);
    assert.ok(read(f.record).deployStartedAt, "an interrupted deploy stays visible in the record");
    const again = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: true, run: spyRun().run, git: cleanGit() });
    assert.match(!again.ok ? again.reason : "", /started at .* and did not finish; check Vercel/);
    const script = readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8");
    // the record comes back to the checkout on ANY exit, and the private TMPDIR is set before any tool (pnpm) runs
    assert.match(script, /if \[ -f "\$r" \] && grep -q '"deployStartedAt": "' "\$r"; then/);
    // a failed copy-back keeps the folder that holds the record and fails the release
    assert.match(script, /trap 'if bring_back; then rm -rf "\$WORK"; else echo "release: could not copy the record back; it is kept at \$WORK\/repo\/release\/robinhood-prebuilt\.json[^']*exit 1; fi' EXIT/);
    // whether the contracts are built is asked of trust-config's parser, after --preflight, and the build is forced
    assert.match(script, /--preflight[\s\S]*CONFIG_STATE="\$\("\$\{TSX\[@\]\}" ops\/trust-config\.ts --config-state\)"\nif \[ "\$CONFIG_STATE" != "null" \]; then[\s\S]*forge build --force/);
    assert.doesNotMatch(script, /grep -qx 'export const TRUSTED_FACTORY/);
    assert.ok(script.indexOf('export TMPDIR="$WORK/tmp"') < script.indexOf("pnpm --version"), "TMPDIR before pnpm --version");
  });

  it("the release runs only the verified pinned CLI: installed from the committed lockfile, never npx", () => {
    const script = readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8");
    const ci = readFileSync(join(REPO, ".github/workflows/evm.yml"), "utf8");
    const commands = (t: string) => t.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n"); // comments are not commands
    // the script installs the CLI with --install-cli and runs every Vercel command as `node "$VC"`
    assert.match(script, /VC="\$\("\$\{TSX\[@\]\}" ops\/release-deploy\.ts --install-cli "\$WORK\/cli"\)"/);
    for (const sub of ["pull", "build"]) assert.match(commands(script), new RegExp(`--run-cli "\\$VC" --cwd app -- ${sub} `), sub);
    assert.match(commands(script), /"\$\{TSX\[@\]\}" ops\/release-deploy\.ts --record release\/robinhood-prebuilt\.json --cli "\$VC"/);
    // npx running Vercel (`npx [flags] vercel…`, any version), or a bare `vercel` command; paths like .vercel/ are not
    assert.doesNotMatch(commands(script), /vercel@|\bnpx(\s+-\S+)*\s+vercel\b|(?<![.\/\w-])vercel(?![@\w.-])/, "no npx or bare vercel in the release");
    // CI (a test environment, not the release) uses only the pinned version
    const specs = [...commands(ci).matchAll(/vercel@([^\s"')]*)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(specs)], [VERCEL_CLI]);
    // the committed lockfile pins exactly VERCEL_CLI at VERCEL_CLI_INTEGRITY
    const lock = JSON.parse(readFileSync(join(REPO, "ops/vercel-cli/package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/vercel"].version, VERCEL_CLI);
    assert.equal(lock.packages["node_modules/vercel"].integrity, VERCEL_CLI_INTEGRITY);
  });

  it("pull and build run the verified CLI in the allow-listed environment; the release resets app/.vercel first", () => {
    const calls: { cmd: string; a: string[]; o: { cwd: string; env: NodeJS.ProcessEnv } }[] = [];
    const saved = { ...process.env };
    process.env.VERCEL_BUILDERS_DIR = "/planted";
    process.env.NODE_OPTIONS = "--require /planted.js";
    process.env.VERCEL_CLI_USE_NATIVE_BINARY = "1";
    const root = mkdtempSync(join(tmpdir(), "release-run-cli-"));
    const target = reviewedTarget(root);
    try {
      const code = execPinnedCli(fakePinnedCli(), ["build", "--yes"], root, (cmd, a, o) => { calls.push({ cmd, a, o }); return 0; }, target);
      assert.equal(code, 0);
    } finally {
      for (const k of ["VERCEL_BUILDERS_DIR", "NODE_OPTIONS", "VERCEL_CLI_USE_NATIVE_BINARY"]) if (saved[k] === undefined) delete process.env[k];
    }
    assert.equal(calls[0]!.cmd, process.execPath);
    assert.deepEqual(calls[0]!.a, [fakePinnedCli(), "build", "--yes"]);
    assert.equal(calls[0]!.o.cwd, join(root, "app"));
    for (const k of ["VERCEL_BUILDERS_DIR", "NODE_OPTIONS", "VERCEL_CLI_USE_NATIVE_BINARY"]) assert.equal(calls[0]!.o.env[k], undefined, k);
    assert.throws(() => execPinnedCli("/tmp/not-an-install/node_modules/vercel/dist/vc.js", ["build", "--yes"], root, () => 0, target), /not-an-install/);
    const script = readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8");
    // the release builds from a fresh clone of the commit, installs from the lockfiles, and copies only the record back
    assert.match(script, /export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=\/dev\/null\ngit clone -q --no-local --template= -c core\.hooksPath=\/dev\/null "\$REPO" "\$WORK\/repo"\ngit -C "\$WORK\/repo" -c core\.hooksPath=\/dev\/null checkout -q --detach "\$COMMIT"/);
    // the whole release runs in an environment of only the listed variables (npm_config_*, GIT_*, NODE_* … dropped)
    assert.match(script, /exec env -i "\$\{keep\[@\]\}" bash "\$SCRIPT" "\$@"/);
    assert.doesNotMatch(script.match(/ALLOWED_ENV=\([^)]*\)/)![0], /npm_config|NODE_|GIT_|VERCEL_|PNPM/);
    // the seal flag is not trusted: the environment is checked to hold only the allowed variables
    assert.match(script, /extra="\$\(env \| cut -d= -f1 \| grep -vxE/);
    // the build folder is private, under HOME, never the shared /tmp
    assert.match(script, /WORK="\$\(mktemp -d "\$HOME\/\.cache\/othello-release\/XXXXXXXX"\)"/);
    // and every later step's temporary files (tsx's transform cache among them) live inside it; tsx caches nothing
    assert.match(script, /export TMPDIR="\$WORK\/tmp"; mkdir -m 700 "\$TMPDIR"/);
    assert.match(script, /TSX=\(node "\$WORK\/repo\/node_modules\/tsx\/dist\/cli\.mjs" --no-cache\)/);
    assert.match(script, /mkdir "\$WORK\/repo\/app\/\.vercel" && cp app\/\.vercel\/project\.json "\$WORK\/repo\/app\/\.vercel\/project\.json"\ncd "\$WORK\/repo"/);
    assert.match(script, /cd "\$WORK\/repo"\npnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile\npnpm -C app install --frozen-lockfile --ignore-scripts --ignore-pnpmfile\n/);
    const cmds = script.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n"); // comments are not commands
    assert.doesNotMatch(cmds, /\bnpx\b/, "no step of the release goes through npx");
    assert.match(script, /--preflight[\s\S]*--install-cli[\s\S]*--run-cli "\$VC" --cwd app -- pull[\s\S]*--run-cli "\$VC" --cwd app -- build[\s\S]*mkdir -p release\n/);
    assert.match(script, /cp "\$r" "\$WORK\/repo\/release\/robinhood-prebuilt\.files\.txt" "\$REPO\/release\/"/);
    const f = fixture();
    mkdirSync(join(f.app, ".vercel", "builders", "node_modules"), { recursive: true });
    assert.match(preflight(f.root).join("\n"), /\.vercel\/builders/);
  });


  it("the runner starts only the release's pull and build, and only for the reviewed target (adversary pass on be54588)", () => {
    const root = mkdtempSync(join(tmpdir(), "release-run-cli-"));
    const target = reviewedTarget(root);
    let started = 0;
    const spy = () => { started++; return 0; };
    for (const args of [["pull", "--yes", "--environment=preview"], ["pull", "--yes", "--environment=production"], ["build", "--yes"], ["build", "--yes", "--prod"]]) {
      assert.equal(execPinnedCli(fakePinnedCli(), args, root, spy, target), 0, args.join(" "));
    }
    assert.equal(started, 4);
    // deploy goes through --record alone; no other command, and no flag that moves the CLI to another folder, team or login
    for (const args of [
      [], ["deploy", "--prebuilt", "--prod"], ["link", "--yes"], ["promote", "x"], ["env", "pull"],
      ["pull", "--yes", "--environment=production", "--scope", "team_other"], ["build", "--yes", "--cwd", "/tmp"],
      ["--cwd", "/tmp", "build", "--yes"], ["build", "--yes", "--local-config", "/tmp/vercel.json"], ["build", "--yes", "--token", "t"],
      ["pull", "--yes", "--environment=preview", "--global-config", "/tmp/cfg"], ["pull", "--yes"], ["build"],
    ]) {
      assert.throws(() => execPinnedCli(fakePinnedCli(), args, root, spy, target), /starts only the release's pull or build/, JSON.stringify(args));
    }
    assert.equal(started, 4, "a refused argument list never starts the CLI");
    // a link to another project in the reviewed team, or the reviewed project under another team
    for (const t of [{ ...target, vercelProjectId: "prj_other" }, { ...target, vercelOrgId: "team_other" }]) {
      assert.throws(() => execPinnedCli(fakePinnedCli(), ["pull", "--yes", "--environment=production"], root, spy, t), /is not the reviewed target/);
    }
    // with no target given, the committed ops/release-target.json is read; a root without one has no reviewed target
    assert.throws(() => execPinnedCli(fakePinnedCli(), ["pull", "--yes", "--environment=production"], root, spy), /no reviewed target/);
    // the other preflight refusals hold here too: a root vercel.json would move the CLI
    writeFileSync(join(root, "vercel.json"), "{}");
    assert.throws(() => execPinnedCli(fakePinnedCli(), ["build", "--yes"], root, spy, target), /REFUSED before the CLI started/);
    assert.equal(started, 4);
  });
  it("the release refuses any Vercel link but the reviewed target's (Codex r4 F1), before pull, before the scan and at deploy", async () => {
    const setup = (target: object | null, link: object | null, uncommitted?: object) => {
      const root = mkdtempSync(join(tmpdir(), "release-target-"));
      mkdirSync(join(root, "ops"));
      mkdirSync(join(root, "app", ".vercel"), { recursive: true });
      if (target) commitTarget(root, target); // the committed (reviewed) target
      if (uncommitted) writeFileSync(join(root, "ops", "release-target.json"), JSON.stringify(uncommitted));
      if (link) writeFileSync(join(root, "app", ".vercel", "project.json"), JSON.stringify(link));
      return releaseTargetRefusals(root, join(root, "app"));
    };
    const target = { vercelOrgId: "team_A", vercelProjectId: "prj_A" };
    assert.deepEqual(setup(target, { orgId: "team_A", projectId: "prj_A", settings: {} }), []);
    assert.match(setup(target, { orgId: "team_B", projectId: "prj_A" }).join(), /orgId "team_B" is not the reviewed target team_A/);
    assert.match(setup(target, { orgId: "team_A", projectId: "prj_B" }).join(), /projectId "prj_B" is not the reviewed target prj_A/);
    assert.match(setup(null, { orgId: "team_A", projectId: "prj_A" }).join(), /no reviewed target/);
    assert.match(setup({ vercelOrgId: "team_A" }, { orgId: "team_A", projectId: "prj_A" }).join(), /must name vercelOrgId and vercelProjectId/);
    assert.match(setup(target, null).join(), /link the reviewed target project first/);
    // only the committed target counts: an uncommitted edit naming the link's project is refused (adversary pass on 222e3fc)
    const other = { vercelOrgId: "team_B", vercelProjectId: "prj_B" };
    assert.match(setup(target, { orgId: "team_B", projectId: "prj_B" }, other).join(), /differs from the committed copy at HEAD/);
    // a target file present but never committed is no reviewed target either
    const plain = mkdtempSync(join(tmpdir(), "release-target-plain-"));
    mkdirSync(join(plain, "ops"));
    writeFileSync(join(plain, "ops", "release-target.json"), JSON.stringify(target));
    assert.match(releaseTargetRefusals(plain, join(plain, "app")).join(), /not committed at HEAD/);
    // nor is a checkout whose top is above the release root (HEAD would name another folder's file)
    const outer = mkdtempSync(join(tmpdir(), "release-target-outer-"));
    commitTarget(outer, target);
    const inner = join(outer, "sub");
    mkdirSync(join(inner, "ops"), { recursive: true });
    writeFileSync(join(inner, "ops", "release-target.json"), JSON.stringify(target));
    assert.match(releaseTargetRefusals(inner, join(inner, "app")).join(), /is not the top of its git checkout/);
    // and the deploy step refuses a link that is not the target it is given (the release reads the committed one)
    const f = fixture();
    const spy = spyRun();
    const r = await deployRecorded({ cli: fakePinnedCli(), target: { vercelOrgId: "team_A", vercelProjectId: "prj_A" }, root: f.root, recordFile: f.record, prod: true, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /orgId "team_TEST" is not the reviewed target team_A[\s\S]*projectId "prj_TEST" is not the reviewed target prj_A/);
    assert.equal(spy.calls.length, 0, "the CLI never started");
    const noTarget = await deployRecorded({ cli: fakePinnedCli(), root: f.root, recordFile: f.record, prod: true, run: spy.run, git: cleanGit() });
    assert.match(!noTarget.ok ? noTarget.reason : "", /no reviewed target/, "without a committed ops/release-target.json the deploy refuses");
    // the committed target is the othello project, and the script checks it before pull and again after build
    const committed = JSON.parse(readFileSync(join(REPO, "ops/release-target.json"), "utf8"));
    assert.deepEqual([committed.vercelOrgId, committed.vercelProjectId], ["team_kXXQhD4pqG6KG2NfVVFlVOHi", "prj_ZCQ6bP09jJeMX1wOwg7ErhJe8wB8"]);
    const script = readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8");
    assert.match(script, /--preflight[^\n]*\n[\s\S]*-- pull [\s\S]*-- build [^\n]*\n"\$\{TSX\[@\]\}" ops\/release-deploy\.ts --preflight[\s\S]*--record release/);
  });

  it("anything above the clone that node or a build tool would read is refused by the preflight", () => {
    for (const name of ["node_modules", "package.json", "postcss.config.js", ".browserslistrc", "pnpm-workspace.yaml", ".babelrc"]) {
      const above = mkdtempSync(join(tmpdir(), "release-ancestor-"));
      const root = join(above, "work", "repo");
      mkdirSync(root, { recursive: true });
      if (name === "node_modules") mkdirSync(join(above, name)); else writeFileSync(join(above, name), "{}");
      assert.match(ancestorRefusals(root).join("\n"), new RegExp(`${name.replace(/\./g, "\\.")}: above the release's clone`), name);
    }
    const clean = mkdtempSync(join(tmpdir(), "release-ancestor-clean-"));
    mkdirSync(join(clean, "work", "repo"), { recursive: true });
    assert.deepEqual(ancestorRefusals(join(clean, "work", "repo")).filter((f) => f.startsWith(clean)), []);
  });

  it("verifyPinnedCli refuses anything but exactly the pinned install, and the deploy refuses without it", async () => {
    const good = fakePinnedCli();
    const dir = join(good, "..", "..", "..", "..");
    assert.equal(verifyPinnedCli(dir), good);
    const bad = (mutate: (d: string) => void, why: RegExp) => {
      const d = mkdtempSync(join(tmpdir(), "pinned-cli-bad-"));
      execFileSync("cp", ["-a", `${dir}/.`, d]);
      mutate(d);
      assert.throws(() => verifyPinnedCli(d), why);
    };
    bad((d) => writeFileSync(join(d, "node_modules", "vercel", "package.json"), JSON.stringify({ version: "59.11.8" })), /is vercel 59\.11\.8/);
    bad((d) => writeFileSync(join(d, "package-lock.json"), readFileSync(join(d, "package-lock.json"), "utf8").replace(/"lockfileVersion"/, "\"x\": 1, \"lockfileVersion\"")), /differs from ops\/vercel-cli/);
    bad((d) => { rmSync(join(d, "node_modules", "vercel", "dist", "vc.js")); symlinkSync("/bin/sh", join(d, "node_modules", "vercel", "dist", "vc.js")); }, /not a regular file/);
    const nonEmpty = mkdtempSync(join(tmpdir(), "pinned-cli-nonempty-"));
    writeFileSync(join(nonEmpty, "x"), "");
    assert.throws(() => installPinnedCli(nonEmpty, () => {}), /not empty/);

    const f = fixture();
    for (const cli of [undefined, join(f.root, "vc.js")]) {
      const spy = spyRun();
      const r = await deployRecorded({ cli: cli as string, target: reviewedTarget(f.root), root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", /runs only the verified pinned CLI/);
      assert.equal(spy.calls.length, 0);
    }
  });
});
