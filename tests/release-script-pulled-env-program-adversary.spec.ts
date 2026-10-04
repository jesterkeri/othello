/**
 * Adversary test on ce04cd9 (Codex code review r5 F1: the Vercel project's remote build settings are executable input;
 * no custom command may run in a folder holding pulled secrets, and no artifact built under unreviewed settings may be
 * uploaded).
 *
 * The fix binds `settings` in app/.vercel/project.json to ops/release-target.json's vercelSettings. But `vercel pull`
 * also writes the project's Environment Variables into app/.vercel/.env.<target>.local (pinned 59.11.7,
 * dist/chunks/chunk-GHKJAK5V.js:1201: `# Created by Vercel CLI` then `KEY="value"` for every record), and the pinned
 * build loads that file into process.env before it runs the builder (dist/commands/build/index.js:4595-4612, dotenv),
 * which spawns `pnpm run build` and next with that environment. cliExtraUploads only names the env files, never reads
 * them, and the release's own NODE_OPTIONS refusal covers only the shell's environment. So a project Environment
 * Variable NODE_OPTIONS (a setting Vercel documents and accepts) names a program that the sealed build runs, with every
 * pulled secret in its environment, and the release scans, records and deploys what it produced.
 *
 * The test runs the real ops/release-robinhood.sh in the sealed harness (no Vercel login, deploy stubbed). The only
 * change to the harness: the stubbed pull writes what a real pull writes for a project whose settings are exactly the
 * reviewed document and whose preview environment holds a sentinel value and NODE_OPTIONS=--import=<data: module>. The
 * planted module only appends a line to a file in the test's temporary folder.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-pulled-env-program-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release: a pulled project environment variable runs no program in the build (adversary on ce04cd9, Codex r5 F1)", function () {
  this.timeout(900_000);

  it("NODE_OPTIONS among the pulled preview variables never runs, and nothing built under it is deployed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-pulled-env-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    // the settings are exactly the reviewed document: the release's settings check passes
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    const ran = join(tmp, "PULLED-NODE-OPTIONS-RAN");
    const mod = `import{appendFileSync}from"node:fs";appendFileSync(${JSON.stringify(ran)},process.argv.slice(1).join(" ")+" sees "+process.env.RELEASE_ADVERSARY_SENTINEL+"\\n")`;
    const nodeOptions = `--import=data:text/javascript;base64,${Buffer.from(mod).toString("base64")}`;
    // the pinned CLI's own pull format (chunk-GHKJAK5V.js:1201): header, then KEY="value" sorted by key
    const pulledEnv = join(tmp, "pulled.env.preview.local");
    writeFileSync(pulledEnv, `# Created by Vercel CLI\nNODE_OPTIONS="${nodeOptions}"\nRELEASE_ADVERSARY_SENTINEL="sentinel-not-a-secret"\n`);

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    // the harness's shim, with its pull step writing the pulled env file where `vercel pull --environment=preview` does
    writeFileSync(join(tmp, "shim", "node"),
      `#!/bin/sh\ncase " $* " in\n` +
      `  *" ops/release-deploy.ts --run-cli "*" pull "*) cp ${JSON.stringify(pulledEnv)} app/.vercel/.env.preview.local && echo "shim: pull wrote the project's preview variables" >&2; exit 0;;\n` +
      `  *" ops/release-deploy.ts --record "*) cp -R app/.vercel/output ${JSON.stringify(uploaded)} && echo "shim: deploy skipped" >&2; exit 0;;\n` +
      `esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(join(tmp, "shim", "node"), 0o755);

    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-20).join("\n");
    assert.match(out, /shim: pull wrote the project's preview variables/, `the release never reached its pull step:\n${tail}`);
    const runs = existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : [];
    assert.equal(runs.length, 0,
      `the build ran a program named by a pulled project variable, ${runs.length} times, with the pulled values in its environment ` +
      `(release exit ${r.status}, deployed ${existsSync(uploaded)}):\n${runs.slice(0, 3).join("\n")}`);
    assert.equal(existsSync(uploaded), false, "an artifact built under an unreviewed pulled variable reached the deploy step");
  });
});
