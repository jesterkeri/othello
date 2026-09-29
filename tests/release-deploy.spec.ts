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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deployEnv, deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { VERCEL_CLI, artifactDigest, esc, scanTree, writeRecord, type ReleaseRecord } from "../ops/trust-config.ts";

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
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /changed after it was scanned; nothing was deployed[\s\S]*upload:\.next\/server\/app\/robinhood\/page\.js/);
    assert.equal(spy.calls.length, 0, "vercel was never run");
    assert.equal(read(f.record).deploymentUrl, null);
  });

  it("a changed or added output file is refused the same way", async () => {
    const f = fixture();
    writeFileSync(join(f.out, "static", "extra.js"), "late");
    const spy = spyRun();
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /\+ static\/extra\.js/);
    assert.equal(spy.calls.length, 0);
  });

  it("an unchanged artifact deploys with the pinned CLI from app/, and the URL goes into the record", async () => {
    const f = fixture();
    const spy = spyRun();
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.deepEqual(r, { ok: true, url: DEPLOY_URL });
    assert.deepEqual(spy.calls, [{ cmd: "npx", args: ["--yes", `vercel@${VERCEL_CLI}`, "deploy", "--prebuilt"], cwd: f.app }]);
    const rec = read(f.record);
    assert.equal(rec.deploymentUrl, DEPLOY_URL);
    assert.equal(rec.target, "preview");
    assert.equal(rec.vercelCli, VERCEL_CLI);
    assert.equal(rec.commit, COMMIT);
  });

  it("--prod passes --prod and records production", async () => {
    const f = fixture();
    const spy = spyRun();
    await deployRecorded({ root: f.root, recordFile: f.record, prod: true, run: spy.run, git: cleanGit() });
    assert.deepEqual(spy.calls[0]!.args.slice(-1), ["--prod"]);
    assert.equal(read(f.record).target, "production");
  });

  it("a file changed during the upload voids the deployment: no URL recorded, told not to use it", async () => {
    const f = fixture();
    const spy = spyRun(() => writeFileSync(f.server, "rebuilt by next build during the upload"));
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", new RegExp(`changed while they were uploading, so ${DEPLOY_URL.replace(/\./g, "\\.")} may not be the scanned artifact; do not use or share it`));
    assert.equal(read(f.record).deploymentUrl, null);
  });

  it("refuses a record already deployed, another commit, other changed files, or a record built with another CLI", async () => {
    const f = fixture();
    const spy = spyRun();
    const go = (git: Git) => deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git });

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
      const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", new RegExp(`scan never covered[\\s\\S]*${rel.replace(/\./g, "\\.")}: vercel deploy --prebuilt`), rel);
      assert.equal(spy.calls.length, 0, `${rel}: vercel was never run`);
    }
  });

  it("project.json: a rootDirectory is refused, a change after the record is refused, an env file from pull is allowed", async () => {
    const withProject = (settings: object) => {
      const f = fixture();
      writeFileSync(join(f.app, ".vercel", "project.json"), JSON.stringify({ projectId: "p", orgId: "o", settings }));
      writeFileSync(join(f.app, ".vercel", ".env.preview.local"), "NOT_READ=1\n"); // vercel pull writes one; only its name is checked
      writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root);
      return f;
    };
    const ok = withProject({ framework: "nextjs", rootDirectory: null });
    assert.equal((await deployRecorded({ root: ok.root, recordFile: ok.record, prod: false, run: spyRun().run, git: cleanGit() })).ok, true);

    const rd = withProject({ framework: "nextjs", rootDirectory: "node_modules/x" });
    const spy = spyRun();
    const r1 = await deployRecorded({ root: rd.root, recordFile: rd.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r1.ok ? r1.reason : "", /settings\.rootDirectory "node_modules\/x"/);

    const changed = withProject({ framework: "nextjs", rootDirectory: null });
    writeFileSync(join(changed.app, ".vercel", "project.json"), JSON.stringify({ projectId: "other", orgId: "o", settings: { framework: "nextjs" } }));
    const r2 = await deployRecorded({ root: changed.root, recordFile: changed.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r2.ok ? r2.reason : "", /changed after it was scanned[\s\S]*project:\.vercel\/project\.json/);
    assert.equal(spy.calls.length, 0);
  });

  it("a routes.json written during the upload voids the deployment; in production the message says roll back", async () => {
    for (const prod of [false, true]) {
      const f = fixture();
      const spy = spyRun(() => writeFileSync(join(f.app, ".vercel", "routes.json"), "{}"));
      const r = await deployRecorded({ root: f.root, recordFile: f.record, prod, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", prod ? /already live in production: roll back now/ : /do not use or share it/);
      assert.equal(read(f.record).deploymentUrl, null);
    }
  });

  it("only one https://<deployment>.vercel.app line on stdout is taken as the URL", async () => {
    for (const out of ["https://evil.example.com\n", `${DEPLOY_URL}\nhttps://othello-other-jesterkeri.vercel.app\n`, "https://othello.vercel.app/path\n"]) {
      const f = fixture();
      const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spyRun(undefined, out).run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", /vercel deploy failed/, out);
      assert.equal(read(f.record).deploymentUrl, null);
    }
    const f = fixture();
    const ok = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spyRun(undefined, `Inspect: x\n${DEPLOY_URL}\n${DEPLOY_URL}\n`).run, git: cleanGit() });
    assert.deepEqual(ok, { ok: true, url: DEPLOY_URL });
  });

  it("a failed deploy or one that prints no URL leaves the record unchanged", async () => {
    for (const spy of [spyRun(undefined, "", 1), spyRun(undefined, "Error: not logged in\n", 0)]) {
      const f = fixture();
      const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", /vercel deploy failed/);
      assert.equal(read(f.record).deploymentUrl, null);
    }
  });

  it("an environment that re-targets the CLI is refused, and the CLI gets no VERCEL_* switch", async () => {
    for (const k of ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"]) {
      const f = fixture();
      const spy = spyRun();
      const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit(), env: { [k]: "prj_other" } });
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
    writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root);
    // re-point the link to another file with identical bytes: the upload's link text changes, so the deploy refuses
    writeFileSync(join(f.app, ".next", "server", "app", "page-b.js"), "module.exports = 'server page'");
    rmSync(f.server);
    symlinkSync("page-b.js", f.server);
    const spy = spyRun();
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
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
    writeRecord(f.record, artifactDigest(f.out, f.app), COMMIT, null, f.root);
    rmSync(join(f.app, ".next", "server", "app", "page-link.js"));
    symlinkSync("./page.js", join(f.app, ".next", "server", "app", "page-link.js")); // same target, other text
    const spy = spyRun();
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /changed after it was scanned[\s\S]*upload:b\.js/);
    assert.equal(spy.calls.length, 0);
  });

  it("a special file (FIFO) in the output is refused by the scan and never read by the digest", async () => {
    const f = fixture();
    execFileSync("mkfifo", [join(f.out, "static", "pipe")]);
    assert.match(scanTree(f.out, null, f.app).join("\n"), /static\/pipe: not a regular file/);
    assert.ok(artifactDigest(f.out, f.app).lines.some((l) => /^static\/pipe\tspecial 1\d+$/.test(l)), "listed, not read (no hang)");
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spyRun().run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /changed after it was scanned[\s\S]*static\/pipe/);
  });

  it("app/.vercel/output replaced by a link to a copy is refused (the CLI would upload the link, not the files)", async () => {
    const f = fixture();
    const copy = join(f.root, "output-copy");
    execFileSync("cp", ["-a", f.out, copy]);
    rmSync(f.out, { recursive: true });
    symlinkSync(copy, f.out);
    const spy = spyRun();
    const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
    assert.match(!r.ok ? r.reason : "", /\.vercel\/output \(a link, not a folder\)/);
    assert.equal(spy.calls.length, 0);
  });

  it("a linked app/.vercel, or a name with a tab or line break, is refused", async () => {
    const f = fixture();
    const moved = join(f.root, "vercel-real");
    execFileSync("mv", [join(f.app, ".vercel"), moved]);
    symlinkSync(moved, join(f.app, ".vercel"));
    const r1 = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spyRun().run, git: cleanGit() });
    assert.match(!r1.ok ? r1.reason : "", /\.vercel \(a link, not a folder\)/);

    const g = fixture();
    writeFileSync(join(g.out, "static", "a\tb.js"), "x");
    const spy = spyRun();
    const r2 = await deployRecorded({ root: g.root, recordFile: g.record, prod: false, run: spy.run, git: cleanGit() });
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

  it("the release script and CI build with the same pinned CLI the deploy uses", () => {
    const script = readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8");
    const ci = readFileSync(join(REPO, ".github/workflows/evm.yml"), "utf8");
    for (const [name, text] of [["ops/release-robinhood.sh", script], [".github/workflows/evm.yml", ci]] as const) {
      const commands = text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n"); // shell and YAML comments are not commands
      // every "vercel@<spec>" names exactly the pinned version (not latest, a range or a longer version)
      const specs = [...commands.matchAll(/vercel@([^\s"')]*)/g)].map((m) => m[1]);
      assert.ok(specs.length > 0, `${name} pins a Vercel CLI`);
      assert.deepEqual([...new Set(specs)], [VERCEL_CLI], `${name} uses only vercel@${VERCEL_CLI}`);
      // and no bare "vercel" runs (".vercel/" paths and "Vercel" in prose are not commands)
      assert.doesNotMatch(commands, /(?<![.\/\w-])vercel(?![@\w.-])/, `${name} runs no unpinned vercel`);
    }
    assert.match(script, /ops\/release-deploy\.ts --record release\/robinhood-prebuilt\.json/, "the script deploys only through the checked step");
  });
});
