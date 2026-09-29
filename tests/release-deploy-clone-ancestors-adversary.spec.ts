/**
 * Adversary test for ops/release-robinhood.sh (Codex code review r3 M1: what is deployed is exactly what was built from
 * the reviewed commit and scanned).
 *
 * The release builds in a "fresh clone" at $(mktemp -d)/repo, and TMPDIR is on the sealed allow-list. But Node's
 * module resolution walks up out of the clone: next build does `try { require('@opentelemetry/api') } catch { bundled }`
 * (next/dist/server/lib/trace/tracer.js), the app does not install that package, so the lookup reaches
 * <every ancestor of the clone>/node_modules. Whatever sits in $TMPDIR/node_modules (default /tmp/node_modules) runs
 * inside next build of the clone and can change what is built, scanned, recorded and uploaded without any commit.
 *
 * Second case: the seal itself is switched off by RELEASE_ENV_SEALED=1 in the caller's environment, after which every
 * variable the seal exists to drop reaches the release again (here GIT_CONFIG_COUNT: a smudge filter on the clone).
 *
 * Each case points the page's NEXT_PUBLIC_SOLANA_RPC at a sentinel without any commit; the sentinel must not reach the
 * uploaded output.
 *
 *   npx mocha --import=tsx --timeout 1800000 tests/release-deploy-clone-ancestors-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealedReleaseEnv } from "./release-script-harness.ts";

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
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "",
    "precondition: the checkout is clean");
  return repo;
}

// an @opentelemetry/api that, when next build requires it, points the page's RPC at the sentinel and then throws so
// next falls back to its bundled copy and the build carries on normally
function plantOtel(nodeModules: string, sentinel: string, marker: string): void {
  const pkg = join(nodeModules, "@opentelemetry", "api");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@opentelemetry/api", version: "1.9.0", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"),
    `const fs = require("fs"), path = require("path");\n` +
    `process.env.NEXT_PUBLIC_SOLANA_RPC = "https://${sentinel}/";\n` +
    `const env = path.join(process.cwd(), ".env.local");\n` +
    `if (fs.existsSync(path.join(process.cwd(), ".vercel", "project.json")) && !fs.existsSync(env)) fs.writeFileSync(env, "NEXT_PUBLIC_SOLANA_RPC=https://${sentinel}/\\n");\n` +
    `fs.appendFileSync(${JSON.stringify(marker)}, process.cwd() + "\\n");\n` +
    `throw new Error("fall back to the bundled api");\n`);
}

function release(repo: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout}\n${r.stderr}`;
  if (process.env.ADV_DEBUG) console.log(out.split("\n").filter(Boolean).slice(-30).join("\n"));
  return { r, out };
}

describe("release adversary: the fresh clone is not sealed from what lies around it", function () {
  this.timeout(1_800_000);

  it("a module in $TMPDIR/node_modules (an ancestor of the clone) does not reach the uploaded output", () => {
    const tmp = mkdtempSync(join(SCRATCH, "release-clone-ancestor-"));
    const repo = checkout(tmp);
    const SENTINEL = "planted-tmpdir-ancestor-3c9b1.invalid";
    const marker = join(tmp, "planted-ran.txt");
    const tmpDir = join(tmp, "tmpdir");
    plantOtel(join(tmpDir, "node_modules"), SENTINEL, marker);
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    env.TMPDIR = tmpDir; // an allowed variable; unset, it is /tmp and the lookup reaches /tmp/node_modules the same way
    const { r, out } = release(repo, env);
    const hits = filesContaining(uploaded, SENTINEL);
    assert.deepEqual(hits, [],
      `a module from $TMPDIR/node_modules ran in the clone's next build and its value was built, recorded and uploaded; ` +
      `release exit ${r.status}, planted module ran in: ${existsSync(marker) ? readFileSync(marker, "utf8").trim() : "(nowhere)"}`);
    assert.ok((r.status !== 0 && !existsSync(uploaded)) || (r.status === 0 && existsSync(uploaded) && /Detected Next\.js version/.test(out)),
      `neither a refusal nor a completed release (exit ${r.status}):\n${out.slice(-3000)}`);
  });

  it("a node_modules above the release's build folder (in HOME) is refused before anything is built", () => {
    // added with the fix (F-17 seventeenth pass): the clone now lives under $HOME/.cache/othello-release, so plant the
    // same module one level above it, in HOME itself
    const tmp = mkdtempSync(join(SCRATCH, "release-home-ancestor-"));
    const repo = checkout(tmp);
    const SENTINEL = "planted-home-ancestor-5e02f.invalid";
    const marker = join(tmp, "planted-ran.txt");
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    plantOtel(join(env.HOME!, "node_modules"), SENTINEL, marker);
    const { r, out } = release(repo, env);
    assert.deepEqual(filesContaining(uploaded, SENTINEL), [], `a module above the build folder reached the upload (exit ${r.status})`);
    assert.notEqual(r.status, 0, "the release refused");
    assert.equal(existsSync(uploaded), false, "nothing reached the deploy step");
    assert.match(out, /node_modules: above the release's clone, the build would read it/, out.slice(-2000));
  });

  it("RELEASE_ENV_SEALED=1 from the caller does not switch the seal off (git config from GIT_CONFIG_COUNT must not reach the clone)", () => {
    const tmp = mkdtempSync(join(SCRATCH, "release-sealed-flag-"));
    const repo = checkout(tmp);
    const SENTINEL = "planted-sealed-flag-81d2e.invalid";
    const attrs = join(tmp, "attributes");
    writeFileSync(attrs, "app/src/lib/wallet.tsx filter=plant\n");
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    env.RELEASE_ENV_SEALED = "1";
    // command-scope git config: an attributes file outside the commit, and a smudge filter that rewrites the checkout
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_0 = "core.attributesFile";
    env.GIT_CONFIG_VALUE_0 = attrs;
    env.GIT_CONFIG_KEY_1 = "filter.plant.smudge";
    env.GIT_CONFIG_VALUE_1 = `sed 's#process.env.NEXT_PUBLIC_SOLANA_RPC ||#String("https://${SENTINEL}/") ||#'`;
    // and its inverse as the clean filter, so `git status` in the clone (trust-config's dirty check) sees the commit
    env.GIT_CONFIG_COUNT = "3";
    env.GIT_CONFIG_KEY_2 = "filter.plant.clean";
    env.GIT_CONFIG_VALUE_2 = `sed 's#String("https://${SENTINEL}/") ||#process.env.NEXT_PUBLIC_SOLANA_RPC ||#'`;
    const { r, out } = release(repo, env);
    const hits = filesContaining(uploaded, SENTINEL);
    assert.deepEqual(hits, [],
      `with RELEASE_ENV_SEALED=1 inherited, a GIT_CONFIG_COUNT smudge filter rewrote the clone and it was built, recorded and uploaded; release exit ${r.status}`);
    assert.ok((r.status !== 0 && !existsSync(uploaded)) || (r.status === 0 && existsSync(uploaded) && /Detected Next\.js version/.test(out)),
      `neither a refusal nor a completed release (exit ${r.status}):\n${out.slice(-3000)}`);
  });
});
