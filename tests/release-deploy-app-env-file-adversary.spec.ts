/**
 * Adversary test for ops/release-robinhood.sh (Codex code review r3 M1: pin the Vercel CLI; the release must bind what
 * Vercel receives).
 *
 * The release now runs pull and build through release-deploy.ts --run-cli, which gives the CLI an allow-listed
 * environment (deployEnv), so no NEXT_PUBLIC_* or other variable from the shell reaches the build. But `next build`
 * (run by the locked @vercel/next builder inside app/) loads app/.env.production.local, app/.env.local,
 * app/.env.production and app/.env itself, and inlines every NEXT_PUBLIC_* it finds there into the client chunks. All
 * of those names are gitignored (`.env.*`, `.env`), so the clean-checkout check does not see them, and neither the
 * app/.vercel reset nor --preflight nor trust-config's scan looks at them (the scan only looks for addresses). A local
 * development `.env.local` therefore changes the bytes the release scans, records and uploads, without a commit.
 *
 * The test clones this repository at HEAD into a temporary folder, writes app/.env.local with a sentinel
 * NEXT_PUBLIC_SOLANA_RPC (read by app/src/lib/wallet.tsx), and runs the real ops/release-robinhood.sh. The only
 * substitution is an `npx` shim on PATH that turns the pull step and the deploy step into no-ops, with HOME a fresh
 * temporary folder, so no Vercel login exists and nothing can contact Vercel; the install, build and scan are real.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-app-env-file-adversary.spec.ts
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

describe("release adversary: a gitignored app/.env.local takes part in the release build", function () {
  this.timeout(900_000);

  it("no NEXT_PUBLIC_* value from an uncommitted app/.env file reaches the uploaded output", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-app-env-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");

    const app = join(repo, "app");
    const vercelDir = join(app, ".vercel");
    mkdirSync(vercelDir, { recursive: true });
    // the same offline link CI's scanned-build job writes
    writeFileSync(join(vercelDir, "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: { framework: "nextjs", installCommand: "true" } }));
    commitTestReleaseTarget(repo); // the release refuses any link but the reviewed target's (Codex r4 F1)

    // (no release/ folder is created here: the release must create it itself, the pass's second finding)
    // a developer's local env file: gitignored, never committed, never reviewed
    const SENTINEL = "planted-env-rpc-9f3c2a.invalid";
    writeFileSync(join(app, ".env.local"), `NEXT_PUBLIC_SOLANA_RPC=https://${SENTINEL}/\n`);
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "",
      "precondition: app/.env.local is invisible to the release's clean-checkout check");

    // (Adapted after the fix, F-17 fifteenth pass: the release builds in a fresh clone that it deletes, so the sealed
    // harness copies exactly the folder that would be uploaded before skipping the deploy, and that copy is searched.)
    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");

    if (process.env.ADV_DEBUG) console.log(tail);
    const hits = filesContaining(uploaded, SENTINEL);
    // trust-config wrote its record in the clone (so release/ was created there); the sealed deploy step keeps a copy.
    // (A stubbed deploy never marks "deploy started", so, correctly, no record comes back to the checkout.)
    const recorded = existsSync(`${uploaded}.record.json`);
    assert.deepEqual(hits, [],
      `app/.env.local (uncommitted) is inlined into the uploaded output; release exit ${r.status}, record written: ${recorded}\n${tail}`);
    // not vacuous: either the release refused, or the build really ran and was recorded
    // not vacuous: the release completed, built, and reached its deploy step with an output, and wrote the record back
    assert.ok(r.status === 0 && existsSync(uploaded) && /Detected Next\.js version/.test(out) && recorded,
      `the release did not build and reach its deploy step (exit ${r.status}, uploaded ${existsSync(uploaded)}, record ${recorded}):\n${tail}`);
  });
});
