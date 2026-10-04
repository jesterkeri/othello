/**
 * Adversary check on a76e46a (requirement 3: a correctly configured ordinary full clone, the contracts' submodules
 * initialised under evm/lib/ and an `origin` remote with a normal URL, still releases end to end; the refusals added for
 * fetch-time programs and partial clones must not trip on it).
 *
 * The operator's checkout is made the way an operator makes one: a full clone, then `git submodule update --init` of
 * both libraries under evm/lib/ (objects taken from a local copy under this repository's git directory when one exists,
 * read only, otherwise from the URL in .gitmodules), then the submodule URLs and the superproject's origin set back to
 * the public GitHub URLs a clone from GitHub would carry. Nothing is fetched from those URLs: the release never fetches
 * in the operator's checkout, and the committed config has no TRUSTED_FACTORY, so the release clone does not either.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-normal-clone-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUBS = ["evm/lib/forge-std", "evm/lib/openzeppelin-contracts"];

/** A local repository that already holds the library's pinned commit (an initialized module of any worktree), else the URL. */
function librarySource(sub: string): string {
  const common = resolve(ROOT, execFileSync("git", ["-C", ROOT, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
  const candidates = [join(common, "modules", sub)];
  const wt = join(common, "worktrees");
  if (existsSync(wt)) for (const w of readdirSync(wt)) candidates.push(join(wt, w, "modules", sub));
  const pinned = execFileSync("git", ["-C", ROOT, "rev-parse", `HEAD:${sub}`], { encoding: "utf8" }).trim();
  for (const c of candidates) {
    if (spawnSync("git", ["--git-dir", c, "cat-file", "-e", `${pinned}^{commit}`]).status === 0) return c;
  }
  return execFileSync("git", ["-C", ROOT, "config", "-f", ".gitmodules", `submodule.${sub}.url`], { encoding: "utf8" }).trim();
}

describe("release: an ordinary full clone with its libraries initialised still releases (adversary on a76e46a)", function () {
  this.timeout(900_000);

  it("the clean-checkout check and the config refusals pass a normal checkout, and the release reaches its deploy step", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-normal-clone-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    const head = commitTestReleaseTarget(repo);

    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    for (const sub of SUBS) {
      const url = git("config", "-f", ".gitmodules", `submodule.${sub}.url`).trim();
      git("submodule", "init", sub);
      git("config", `submodule.${sub}.url`, librarySource(sub));
      git("-c", "protocol.file.allow=always", "submodule", "update", "--quiet", sub);
      // as a clone from GitHub leaves them
      git("config", `submodule.${sub}.url`, url);
      execFileSync("git", ["-C", join(repo, sub), "remote", "set-url", "origin", url]);
      assert.equal(git("rev-parse", `HEAD:${sub}`).trim(), execFileSync("git", ["-C", join(repo, sub), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        `precondition: ${sub} is checked out at the committed commit`);
    }
    git("remote", "set-url", "origin", "https://github.com/jesterkeri/othello.git");
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "precondition: the checkout is clean, submodules included");

    const uploaded = join(tmp, "uploaded-output");
    const env = sealedReleaseEnv(tmp, uploaded);
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
    assert.ok(r.status === 0 && existsSync(uploaded) && out.includes(`Released from a fresh clone of ${head}`),
      `an ordinary checkout did not release (exit ${r.status}, uploaded ${existsSync(uploaded)}):\n${tail}`);
  });
});
