/**
 * Adversary test for ops/release-robinhood.sh (Codex code review r3 M1: the release must bind what Vercel receives).
 *
 * The release refuses NODE_OPTIONS because "it would change every node step of the release". But every node step
 * after the fresh clone is started through `npx`, and npm turns its `node-options` setting into NODE_OPTIONS for
 * whatever it runs (npm/@npmcli/config set-envs.js: `env.NODE_OPTIONS = cliConf['node-options']`). That setting is read
 * from the environment as npm_config_node_options, which the release never looks at. So a preload reaches the
 * --preflight, --install-cli, --run-cli (parent), trust-config and --record steps anyway, runs inside the fresh clone,
 * and can change what is built, scanned, recorded and uploaded without any commit.
 *
 * The test clones this repository at HEAD, sets only npm_config_node_options to preload a small script, and runs the
 * real ops/release-robinhood.sh in the sealed harness (pull and deploy stubbed, empty HOME). The preload writes an
 * app/.env.local with a sentinel NEXT_PUBLIC_SOLANA_RPC into the clone (the gitignored file the fresh clone exists to
 * keep out); the sentinel must not reach the uploaded output.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-deploy-npm-node-options-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

describe("release adversary: npm_config_node_options passes the NODE_OPTIONS refusal", function () {
  this.timeout(900_000);

  it("no preload given through npm's node-options reaches the uploaded output", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-npm-node-options-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    const vercelDir = join(repo, "app", ".vercel");
    mkdirSync(vercelDir, { recursive: true });
    // the same offline link CI's scanned-build job writes
    writeFileSync(join(vercelDir, "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: { framework: "nextjs", installCommand: "true" } }));
    commitTestReleaseTarget(repo); // the release refuses any link but the reviewed target's (Codex r4 F1)
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "",
      "precondition: the checkout is clean");

    const SENTINEL = "planted-npm-node-options-7d41e.invalid";
    const marker = join(tmp, "preload-ran.txt");
    const preload = join(tmp, "preload.cjs");
    // runs in every node process npx starts; inside the release's fresh clone (never the checkout) it plants the env file
    writeFileSync(preload,
      `const fs = require("fs"), path = require("path");\n` +
      `const cwd = process.cwd();\n` +
      `if (cwd !== ${JSON.stringify(repo)} && fs.existsSync(path.join(cwd, "app", ".vercel", "project.json")) && !fs.existsSync(path.join(cwd, "app", ".env.local"))) {\n` +
      `  fs.writeFileSync(path.join(cwd, "app", ".env.local"), "NEXT_PUBLIC_SOLANA_RPC=https://${SENTINEL}/\\n");\n` +
      `  fs.appendFileSync(${JSON.stringify(marker)}, cwd + "\\n");\n` +
      `}\n`);

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    delete env.NODE_OPTIONS;
    env.npm_config_node_options = `--require ${preload}`;
    // the same plant through git (added with the fix, F-17 sixteenth pass): a clone template and a config-set hooks path,
    // each with a post-checkout hook that writes app/.env.local in the clone
    const hook = `#!/bin/sh\n[ -f app/.vercel/project.json ] || [ -d app ] && printf 'NEXT_PUBLIC_SOLANA_RPC=https://${SENTINEL}/\\n' > app/.env.local && echo "$PWD" >> ${JSON.stringify(marker)}\n`;
    for (const dir of [join(tmp, "git-template", "hooks"), join(tmp, "git-hooks")]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "post-checkout"), hook);
      chmodSync(join(dir, "post-checkout"), 0o755);
    }
    env.GIT_TEMPLATE_DIR = join(tmp, "git-template");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    env.GIT_CONFIG_VALUE_0 = join(tmp, "git-hooks");
    env.npm_config_global_pnpmfile = preload;
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
    if (process.env.ADV_DEBUG) console.log(tail);

    const hits = filesContaining(uploaded, SENTINEL);
    const recorded = existsSync(join(repo, "release", "robinhood-prebuilt.files.txt"));
    assert.deepEqual(hits, [],
      `a preload from npm_config_node_options planted app/.env.local in the fresh clone and it was built, recorded and uploaded; ` +
      `release exit ${r.status}, record written back: ${recorded}, preload ran in: ${existsSync(marker) ? readFileSync(marker, "utf8").trim() : "(nowhere)"}`);
    // not vacuous: either the release refused before building, or it built and reached its deploy step
    assert.ok((r.status !== 0 && !existsSync(uploaded)) || (r.status === 0 && existsSync(uploaded) && /Detected Next\.js version/.test(out)),
      `neither a refusal nor a completed release (exit ${r.status}, uploaded ${existsSync(uploaded)}):\n${tail}`);
  });
});
