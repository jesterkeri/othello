/**
 * The release deploy step (ops/release-deploy.ts, Codex code review r3 M1): Vercel is contacted only when the upload
 * set still equals the recorded scan, with the pinned CLI, and the record gets a DEPLOY_URL only if nothing changed during
 * the upload. The artifact is a small hand-made prebuilt output of the shape vercel@59.11.7 writes: a static file plus
 * a function whose `.vc-config.json` filePathMap uploads a server file from the project directory. No network.
 *
 *   npx mocha --import=tsx tests/release-deploy.spec.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { VERCEL_CLI, artifactDigest, writeRecord, type ReleaseRecord } from "../ops/trust-config.ts";

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
    assert.match(!r.ok ? r.reason : "", new RegExp(`changed while they were uploading, so ${DEPLOY_URL.replace(/\./g, "\\.")} may not be the scanned artifact. Do not use`));
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

  it("a failed deploy or one that prints no URL leaves the record unchanged", async () => {
    for (const spy of [spyRun(undefined, "", 1), spyRun(undefined, "Error: not logged in\n", 0)]) {
      const f = fixture();
      const r = await deployRecorded({ root: f.root, recordFile: f.record, prod: false, run: spy.run, git: cleanGit() });
      assert.match(!r.ok ? r.reason : "", /vercel deploy failed/);
      assert.equal(read(f.record).deploymentUrl, null);
    }
  });

  it("the release script and CI build with the same pinned CLI the deploy uses", () => {
    const script = readFileSync(join(REPO, "ops/release-robinhood.sh"), "utf8");
    const ci = readFileSync(join(REPO, ".github/workflows/evm.yml"), "utf8");
    for (const [name, text] of [["ops/release-robinhood.sh", script], [".github/workflows/evm.yml", ci]] as const) {
      const pins = [...text.matchAll(/vercel@([0-9.]+)/g)].map((m) => m[1]);
      assert.ok(pins.length > 0, `${name} pins a Vercel CLI`);
      assert.deepEqual([...new Set(pins)], [VERCEL_CLI], `${name} uses only vercel@${VERCEL_CLI}`);
      const commands = text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n"); // shell and YAML comments are not commands
      assert.doesNotMatch(commands.replace(/vercel@[0-9.]+/g, ""), /(^|[\s("])vercel (pull|build|deploy)/m, `${name} runs no unpinned vercel`);
    }
    assert.match(script, /ops\/release-deploy\.ts --record release\/robinhood-prebuilt\.json/, "the script deploys only through the checked step");
  });
});
