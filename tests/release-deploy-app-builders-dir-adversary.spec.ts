/**
 * Adversary test for ops/release-robinhood.sh (Codex code review r3 M1: pin the Vercel CLI; the release must bind what
 * Vercel receives).
 *
 * The release now runs `node <verified install>/node_modules/vercel/dist/vc.js build`. But vercel@59.11.7's builder
 * loader (dist/chunks/chunk-TGNEG57M.js resolveBuilders, getBuildersDir2) reads every builder FIRST from
 * `<app>/.vercel/builders/node_modules/<name>/package.json` and only falls back to the CLI's own locked dependency when
 * that file is absent; the only check is that the planted package's version string equals the CLI's pin
 * (`@vercel/next` 11.0.2). app/.vercel/ is gitignored, so the release's clean-checkout check does not see it, and
 * nothing in the release removes or refuses it. The CLI itself writes that folder whenever it runs in native mode
 * (VERCEL_VC_NATIVE=1: `npm install` of the builders, with no lockfile), so an earlier native or `vercel dev` run leaves
 * a builder tree there that the pinned JS CLI then executes instead of the locked one.
 *
 * The test clones this repository at HEAD into a temporary folder, plants a builder that writes a sentinel file when
 * required, and runs the real ops/release-robinhood.sh. The only substitution is an `npx` shim on PATH that turns the
 * pull step and the deploy step (release-deploy.ts --run-cli … pull, and --record) into no-ops, with HOME a fresh
 * temporary folder, so no Vercel login exists and nothing can contact Vercel; the install (npm ci of ops/vercel-cli,
 * read-only registry fetches), the build and the scan are real. No login, no deploy.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-app-builders-dir-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release adversary: a builder left in app/.vercel/builders runs instead of the locked one", function () {
  this.timeout(900_000);

  it("the release's build with the pinned CLI never executes code from app/.vercel/builders", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-builders-dir-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    // tsx for the script's `npx tsx ...` steps; excluded so the clean-checkout check still passes
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules")); // the build runs next build
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");

    const app = join(repo, "app");
    const vercelDir = join(app, ".vercel");
    mkdirSync(vercelDir, { recursive: true });
    // the same offline link CI's scanned-build job writes
    writeFileSync(join(vercelDir, "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo); // the release refuses any link but the reviewed target's (Codex r4 F1)

    // the planted builder: same name and version as the CLI's pin, not the locked package's code
    const sentinel = join(tmp, "PLANTED-BUILDER-RAN");
    const planted = join(vercelDir, "builders", "node_modules", "@vercel", "next");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "package.json"), JSON.stringify({ name: "@vercel/next", version: "11.0.2", main: "index.js" }));
    writeFileSync(join(planted, "index.js"),
      `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "planted builder ran"); throw new Error("planted builder loaded");\n`);
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "",
      "precondition: the planted folder is invisible to the release's clean-checkout check");

    // sealed: pull and deploy stubbed (the deploy step copies the upload folder), empty HOME, no Vercel login
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const tail = `${r.stdout}\n${r.stderr}`.split("\n").filter(Boolean).slice(-40).join("\n");
    assert.equal(existsSync(sentinel), false,
      `the pinned CLI's build executed ${planted}/index.js, code that is not in ops/vercel-cli's locked tree (exit ${r.status}):\n${tail}`);
    // and the build did run, with the CLI's own locked @vercel/next (its first lines), so the check above is not vacuous
    assert.match(`${r.stdout}\n${r.stderr}`, /Detected Next\.js version: [0-9.]+[\s\S]*Running "pnpm run build"/,
      `the locked builder never ran, so the build was not exercised (exit ${r.status}):\n${tail}`);
  });
});
