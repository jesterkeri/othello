/**
 * Adversary test for ops/release-robinhood.sh (Codex code review r3 M1: what is deployed is exactly what was built from
 * the reviewed commit and scanned).
 *
 * The release runs its own checks (ops/release-deploy.ts --preflight / --install-cli / --run-cli / --record, and
 * ops/trust-config.ts, the scan that writes the record) through the clone's tsx, several node processes in a row. tsx
 * caches every transformed file in os.tmpdir()/tsx-<uid> (tsx 4.x, dist/temporary-directory-*.mjs and the FileCache in
 * dist/index-*.mjs): it mkdirSync(recursive)s that folder without checking who owns it, and a later process runs the
 * cached code instead of the file. TMPDIR is on the sealed allow-list and defaults to the shared /tmp (mode 1777), so
 * another user can create /tmp/tsx-<uid> first (mode 777), watch it, and rewrite the cached transform of
 * ops/trust-config.ts that an earlier step wrote, before the scan step runs it.
 *
 * Here the "shared /tmp" is a scratch folder passed as TMPDIR (unset, it is /tmp and the path is the same), the other
 * user is a watcher process, and its payload drops a sentinel file into app/.vercel/output before the scan. The
 * sentinel must not reach the scanned, recorded and uploaded output.
 *
 *   npx mocha --import=tsx --timeout 1800000 tests/release-deploy-tsx-cache-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = process.env.ADV_SCRATCH ?? tmpdir();

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  if (!existsSync(dir)) return hits;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 50 * 1024 * 1024 && readFileSync(p).includes(needle)) hits.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  return hits;
}

function checkout(tmp: string): string {
  const repo = join(tmp, "repo");
  execFileSync("git", ["clone", "--quiet", ROOT, repo]);
  const vercelDir = join(repo, "app", ".vercel");
  mkdirSync(vercelDir, { recursive: true });
  writeFileSync(join(vercelDir, "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: { framework: "nextjs", installCommand: "true" } }));
  commitTestReleaseTarget(repo); // the release refuses any link but the reviewed target's (Codex r4 F1)
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "",
    "precondition: the checkout is clean");
  return repo;
}

// the other user's watcher: every cached transform of ops/trust-config.ts gets a payload in front of it, which (only in
// the scan step, the one given --vercel-output) writes the sentinel into the output about to be scanned and uploaded
function watcherSource(cacheDir: string, sentinel: string, log: string): string {
  const payload =
    `;(()=>{const a=process.argv,i=a.indexOf("--vercel-output");if(i>0){const fs=process.getBuiltinModule("node:fs");` +
    `fs.writeFileSync(a[i+1]+"/static/planted-by-other-user.txt",${JSON.stringify(sentinel)});` +
    `fs.appendFileSync(${JSON.stringify(log)},"payload ran in "+process.cwd()+"\\n");}})();\n`;
  return `
const fs = require("fs"), path = require("path");
const dir = ${JSON.stringify(cacheDir)}, payload = ${JSON.stringify(payload)}, log = ${JSON.stringify(log)};
setInterval(() => {
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith(".")) continue;
    const p = path.join(dir, n);
    let v; try { v = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    if (!v || typeof v.code !== "string" || !v.code.includes("function artifactDigest(") || v.code.includes("planted-by-other-user")) continue;
    v.code = payload + v.code;
    const t = path.join(dir, ".swap-" + n);
    fs.writeFileSync(t, JSON.stringify(v));
    fs.renameSync(t, p);
    fs.appendFileSync(log, "rewrote " + n + "\\n");
  }
}, 20);
`;
}

describe("release adversary: the release's own check code is read back from the shared temp folder", function () {
  this.timeout(1_800_000);

  it("a cached tsx transform rewritten in $TMPDIR/tsx-<uid> by another user does not reach the scanned and uploaded output", async () => {
    const tmp = mkdtempSync(join(SCRATCH, "release-tsx-cache-"));
    const repo = checkout(tmp);
    const SENTINEL = "planted-tsx-cache-7f41a.invalid";
    const log = join(tmp, "other-user.log");
    writeFileSync(log, "");
    // the shared temp folder (as /tmp: world-writable, sticky), and the other user's folder in it, created first
    const shared = join(tmp, "shared-tmp");
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    const uid = process.geteuid!();
    const cacheDir = join(shared, `tsx-${uid}`);
    mkdirSync(cacheDir);
    chmodSync(cacheDir, 0o777);
    const watcherFile = join(tmp, "watcher.cjs");
    writeFileSync(watcherFile, watcherSource(cacheDir, SENTINEL, log));
    const watcher = spawn(process.execPath, [watcherFile], { stdio: "ignore" });

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    env.TMPDIR = shared; // an allowed variable; unset, it is /tmp and tsx uses /tmp/tsx-<uid> the same way
    let r: ReturnType<typeof spawnSync>;
    let out: string;
    try {
      const res = await new Promise<{ status: number | null; out: string }>((done) => {
        const p = spawn("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
        let o = "";
        p.stdout.on("data", (b: Buffer) => { o += b.toString(); });
        p.stderr.on("data", (b: Buffer) => { o += b.toString(); });
        p.on("close", (status) => done({ status, out: o }));
      });
      r = { status: res.status } as ReturnType<typeof spawnSync>;
      out = res.out;
    } finally {
      watcher.kill();
    }
    if (process.env.ADV_DEBUG) console.log(out.split("\n").filter(Boolean).slice(-30).join("\n"));
    const hits = filesContaining(uploaded, SENTINEL);
    assert.deepEqual(hits, [],
      `another user's rewrite of the cached ops/trust-config.ts transform ran inside the release's scan step, and its file was ` +
      `scanned, recorded and uploaded; release exit ${r.status}; other user's log:\n${readFileSync(log, "utf8").trim()}`);
    assert.ok((r.status !== 0 && !existsSync(uploaded)) || (r.status === 0 && existsSync(uploaded) && /Detected Next\.js version/.test(out)),
      `neither a refusal nor a completed release (exit ${r.status}):\n${out.slice(-3000)}`);
  });
});
