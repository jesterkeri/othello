/**
 * Codex code review r6 F1: the release kept a caller-chosen PATH and ran env, bash, git and others by bare name, so a
 * program planted first on PATH ran before the environment seal (env at the re-run) or in place of a tool. The trust
 * boundary now (evm/ARB-FINDINGS.md F-40): the operator's own account and toolchain are trusted (anything running as
 * the operator already holds the Vercel login in HOME); everything else is kept out. Before the seal the script runs
 * only builtins and absolute system paths (/usr/bin/readlink, /usr/bin/env -i, /bin/bash -p); right after it, before
 * any lookup on PATH, it drops every PATH entry that is relative, empty, missing, another user's, or writable by group
 * or others (or under such a folder without the sticky bit); git always runs as /usr/bin/git.
 *
 * Each case runs the real script from a throwaway repository holding only the script and one untracked file, so a run
 * that gets through the PATH and environment steps stops at the clean-checkout check: nothing is installed or built.
 *
 *   npx mocha --import=tsx --timeout 120000 tests/release-script-path-trust.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

function throwawayRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "release-path-trust-"));
  mkdirSync(join(repo, "ops"));
  copyFileSync(join(ROOT, "ops", "release-robinhood.sh"), join(repo, "ops", "release-robinhood.sh"));
  const g = (...a: string[]) => execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "only the script");
  writeFileSync(join(repo, "untracked.txt"), "stops the release at its clean-checkout check\n");
  return repo;
}

/** A folder of programs named like the tools the script uses; each one only records that it ran. */
function shims(dir: string, names: string[], sentinel: string): void {
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    writeFileSync(join(dir, n), `#!/bin/sh\necho "${n} $*" >> ${JSON.stringify(sentinel)}\nexit 0\n`);
    chmodSync(join(dir, n), 0o755);
  }
}

function release(repo: string, path: string, cwd = repo) {
  const r = spawnSync("/bin/bash", [join(repo, "ops", "release-robinhood.sh")], {
    cwd, encoding: "utf8", env: { PATH: path, HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const TOOLS = ["env", "bash", "readlink", "git", "id", "stat", "grep", "cut", "sort", "mkdir", "node", "pnpm", "npm", "npx", "forge", "dirname"];

describe("release: a program planted on PATH does not run (Codex r6 F1)", function () {
  this.timeout(120_000);

  it("a folder others can write to, first on PATH, is dropped before any program in it can run", () => {
    const repo = throwawayRepo();
    const tmp = mkdtempSync(join(tmpdir(), "release-path-shims-"));
    const ran = join(tmp, "RAN");
    const open = join(tmp, "open");
    shims(open, TOOLS, ran);
    chmodSync(open, 0o777); // like WSL's /mnt/c folders, or a shared folder another user can write to
    const r = release(repo, `${open}:${SYSTEM_PATH}`);
    assert.equal(existsSync(ran), false, `a planted program ran:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${r.out}`);
    assert.match(r.out, /1 PATH entries that are not the operator's own .* are not used/);
    // not vacuous: the run got through the PATH and environment steps to the clean-checkout check
    assert.match(r.out, /commit, discard or remove changes and untracked files first/);
  });

  it("relative and empty entries are dropped, so nothing runs from the working folder", () => {
    const repo = throwawayRepo();
    const tmp = mkdtempSync(join(tmpdir(), "release-path-cwd-"));
    const ran = join(tmp, "RAN");
    const cwd = join(tmp, "cwd");
    shims(cwd, TOOLS, ran);
    for (const path of [`.:${SYSTEM_PATH}`, `:${SYSTEM_PATH}`, `${SYSTEM_PATH}:`, `/usr/bin::/bin`, `bin:${SYSTEM_PATH}`]) {
      const r = release(repo, path, cwd);
      assert.equal(existsSync(ran), false, `${path}: a program in the working folder ran:\n${r.out}`);
      assert.match(r.out, /PATH entries that are not the operator's own .* are not used/, path);
      assert.match(r.out, /commit, discard or remove changes/, path);
    }
  });

  it("in the operator's own folder first on PATH, the tools run before the seal and git are never taken from it", () => {
    const repo = throwawayRepo();
    const tmp = mkdtempSync(join(tmpdir(), "release-path-own-"));
    const ran = join(tmp, "RAN");
    const own = join(tmp, "own");
    // the release runs these by absolute path (the seal, its environment check, git); the operator's own other tools
    // (node, pnpm, npm, forge, the later file tools) are trusted
    shims(own, ["env", "bash", "readlink", "git", "id", "stat", "cut", "grep"], ran);
    const r = release(repo, `${own}:${SYSTEM_PATH}`);
    assert.equal(existsSync(ran), false, `a program the release runs by absolute path was taken from PATH:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${r.out}`);
    assert.doesNotMatch(r.out, /PATH entries that are not the operator's own/, "the operator's own folder is kept");
    assert.match(r.out, /commit, discard or remove changes/);
  });

  it("a folder of the operator's under one others can write to (no sticky bit) is dropped", () => {
    const repo = throwawayRepo();
    const tmp = mkdtempSync(join(tmpdir(), "release-path-parent-"));
    const ran = join(tmp, "RAN");
    const parent = join(tmp, "shared");
    mkdirSync(parent);
    const inner = join(parent, "bin");
    shims(inner, TOOLS, ran);
    chmodSync(parent, 0o777); // another user could rename `bin` away and put their own in its place
    const r = release(repo, `${inner}:${SYSTEM_PATH}`);
    assert.equal(existsSync(ran), false, `a program under a shared folder ran:\n${r.out}`);
    assert.match(r.out, /1 PATH entries that are not the operator's own/);
    chmodSync(parent, 0o1777); // with the sticky bit, others cannot replace it: kept (and then the shims would be trusted)
    const kept = release(repo, `${SYSTEM_PATH}:${inner}`);
    assert.doesNotMatch(kept.out, /PATH entries that are not the operator's own/);
  });
});
