/**
 * Adversary test on 1e196ff (requirement: the clean-checkout check must still refuse a checkout whose build input
 * differs from HEAD, anything in app/ or at the repository root, tracked or untracked; ignoring submodules must not let
 * an uncommitted change to a build input through).
 *
 * 1e196ff added `--ignore-submodules=all` to the script's clean-checkout `git status`. That switch does more than stop
 * git from looking inside a submodule: git's diff of HEAD against the index drops every ADDED or DELETED gitlink when
 * submodules are ignored "all" (diff.c diff_addremove). So a nested repository holding a new page under app/, staged
 * with `git add` (the index now has a gitlink at app/src/app/extra that HEAD does not), is reported by the plain status
 * as `A  app/src/app/extra` and by the release's status as nothing. Before 1e196ff the release refused this checkout.
 *
 * The nested repository is made here with git itself; nothing outside the test's temporary folder is written.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-staged-gitlink-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NESTED = "app/src/app/extra";

describe("release: a staged gitlink under app/ is an uncommitted change (adversary on 1e196ff)", function () {
  this.timeout(900_000);

  it("the clean-checkout check refuses a checkout whose index adds a nested repository under app/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-staged-gitlink-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    const head = commitTestReleaseTarget(repo);

    // the operator's change: a new page under app/, kept in its own repository and staged in the superproject
    const nested = join(repo, NESTED);
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "page.tsx"), "export default function Extra() { return <p>staged, never committed</p>; }\n");
    const ident = ["-c", "user.name=t", "-c", "user.email=t@t.invalid"];
    execFileSync("git", ["-C", nested, "init", "-q"]);
    execFileSync("git", ["-C", nested, "add", "page.tsx"]);
    execFileSync("git", ["-C", nested, ...ident, "commit", "-q", "-m", "extra page"]);
    execFileSync("git", ["-C", repo, "add", NESTED], { stdio: ["ignore", "pipe", "pipe"] });

    // not vacuous: the index differs from HEAD in app/, and git's own status (submodules not ignored) says so
    const plain = execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    assert.match(plain, new RegExp(`^A  ${NESTED}$`, "m"), `precondition: git reports the staged addition:\n${plain}`);
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-8).join("\n");
    // (Adapted after a76e46a: the release now refuses any gitlink outside evm/lib/ before its status check, with its own
    // message; either refusal is the required one.)
    assert.match(out, /commit, discard or remove changes|a nested repository outside evm\/lib\/ \(app\/src\/app\/extra\)/,
      `the release did not refuse a checkout whose index adds ${NESTED} (release exit ${r.status}, deployed ${existsSync(uploaded)}):\n${tail}`);
    assert.equal(existsSync(uploaded), false, "nothing is deployed from a checkout with an uncommitted change");
  });
});
