/**
 * Adversary pass on aed6598: the release now follows node, npm, pnpm and forge link by link, but only those four names.
 * Every other program a lookup finds in a kept PATH folder is still never looked at, and the release's own tools look
 * several up by name on that same PATH during the build: pnpm runs a package script through `sh`, pnpm's
 * node_modules/.bin shim runs `sed` and `dirname`, and the build asks `uname` and `getconf`. A link in the operator's
 * own folder (mode 755) to a file in a folder others can write to without the sticky bit therefore still runs, during
 * the build, exactly the swap tests/release-script-path-program-link-adversary.spec.ts refuses for pnpm.
 *
 * The run is the sealed harness (tests/release-script-harness.ts: no Vercel login, pull and deploy are no-ops); the
 * planted programs only record their name and then run the system's own, so the release otherwise completes.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-path-child-program-link-adversary.spec.ts
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
// names the release's own tools looked up on PATH during a sealed release of this commit (none of them node, npm, pnpm
// or forge)
const CHILD_PROGRAMS = ["sh", "sed", "dirname", "uname", "getconf"];

describe("release: a program the build's tools look up on PATH, linked from a kept folder into a shared one (adversary pass on aed6598)", function () {
  this.timeout(900_000);

  it("never runs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-child-program-link-"));
    const repo = join(tmp, "repo");
    execFileSync("/usr/bin/git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    // a folder another user can write to without the sticky bit, holding programs that record that they ran and then
    // run the system's own
    const ran = join(tmp, "RAN");
    const shared = join(tmp, "shared");
    mkdirSync(shared);
    for (const n of CHILD_PROGRAMS) {
      const real = [`/usr/bin/${n}`, `/bin/${n}`].find(existsSync);
      assert.ok(real, `precondition: this machine has a system ${n}`);
      writeFileSync(join(shared, n), `#!/bin/sh\necho "${n} $*" >> ${JSON.stringify(ran)}\nexec ${real} "$@"\n`);
      chmodSync(join(shared, n), 0o755);
    }
    chmodSync(shared, 0o777);

    // the operator's own folder (mode 755), first on PATH, holding only links to those programs
    const own = join(tmp, "own-bin");
    mkdirSync(own);
    chmodSync(own, 0o755);
    for (const n of CHILD_PROGRAMS) symlinkSync(join(shared, n), join(own, n));

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    env.PATH = `${own}:${env.PATH}`;
    const r = spawnSync("/bin/bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const tail = `${r.stdout}\n${r.stderr}`.split("\n").filter(Boolean).slice(-15).join("\n");
    assert.equal(existsSync(ran), false,
      `a program in a folder others can write to without the sticky bit ran during the release, reached through a link in a ` +
      `kept PATH folder (release exit ${r.status}):\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${tail}`);
  });
});
