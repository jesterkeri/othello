/**
 * Adversary pass on 275f514 (Codex r6 F1): the PATH filter walks the parents of each entry by its NAME, not by the
 * folder it resolves to. An entry that is a link (the operator's own `~/bin`, say) to a folder of the operator's that
 * sits under a folder others can write to without the sticky bit is kept, though the same folder named directly is
 * dropped: another user can rename that folder away and put their own in its place while the release runs, which is
 * exactly what the parent rule is there to stop (evm/ARB-FINDINGS.md F-40, ops/release-robinhood.sh's PATH comment).
 *
 * The same root (the filter judges the entry's name once, and keeps the name): `/proc/self/cwd` is absolute and its
 * name's parents are root's, so it is kept, yet at every lookup it is the looking process's working folder, which the
 * filter drops when it is spelled `.` or an empty entry.
 *
 * The run uses a throwaway repository holding only the script, committed and clean, so it gets through every check
 * up to the first program looked up on PATH (`pnpm --version`); the planted pnpm only records that it ran.
 *
 *   npx mocha --import=tsx --timeout 120000 tests/release-script-path-symlink-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

function cleanThrowawayRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "release-path-link-"));
  mkdirSync(join(repo, "ops"));
  copyFileSync(join(ROOT, "ops", "release-robinhood.sh"), join(repo, "ops", "release-robinhood.sh"));
  const g = (...a: string[]) => execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "only the script");
  return repo;
}

function release(repo: string, path: string, home: string, cwd = repo) {
  const r = spawnSync("/bin/bash", [join(repo, "ops", "release-robinhood.sh")], {
    cwd, encoding: "utf8", env: { PATH: path, HOME: home, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("release: a PATH entry that links into a shared folder (adversary pass on 275f514)", function () {
  this.timeout(120_000);

  it("is dropped like the folder it resolves to, so a program swapped in there never runs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-path-link-shims-"));
    const ran = join(tmp, "RAN");
    const shared = join(tmp, "shared");
    mkdirSync(shared);
    const inner = join(shared, "bin"); // the operator's own folder, mode 755, under a folder anyone can write to
    mkdirSync(inner);
    writeFileSync(join(inner, "pnpm"), `#!/bin/sh\necho "pnpm $*" >> ${JSON.stringify(ran)}\nexit 1\n`);
    chmodSync(join(inner, "pnpm"), 0o755);
    chmodSync(inner, 0o755);
    chmodSync(shared, 0o777); // no sticky bit: another user can rename `bin` away and put their own in its place
    const link = join(tmp, "own-bin"); // the operator's own link, in the operator's own folder
    symlinkSync(inner, link);

    // control: the folder named directly is dropped, and nothing in it runs
    const direct = release(cleanThrowawayRepo(), `${inner}:${SYSTEM_PATH}`, mkdtempSync(join(tmpdir(), "release-path-link-home-")));
    assert.match(direct.out, /1 PATH entries that are not the operator's own .* are not used/);
    assert.equal(existsSync(ran), false, `control: the planted pnpm ran:\n${direct.out}`);

    // the same folder, reached through a link: it must be dropped too
    const viaLink = release(cleanThrowawayRepo(), `${link}:${SYSTEM_PATH}`, mkdtempSync(join(tmpdir(), "release-path-link-home-")));
    assert.equal(existsSync(ran), false,
      `a program in a folder under a shared folder without the sticky bit ran, reached through a link on PATH:\n` +
      `${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${viaLink.out}`);
  });

  it("/proc/self/cwd, an absolute name for the working folder, is dropped like `.`", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-path-proc-cwd-"));
    const ran = join(tmp, "RAN");
    const repo = cleanThrowawayRepo();
    // a program at the top of the checkout. The release is started from another, empty folder of the operator's, and the
    // script moves into the checkout before it runs `pnpm --version`: an entry that follows the working folder finds it
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(repo, "pnpm"), `#!/bin/sh\necho "pnpm $*" >> ${JSON.stringify(ran)}\nexit 1\n`);
    chmodSync(join(repo, "pnpm"), 0o755);
    execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null", "add", "pnpm"], { stdio: "ignore" });
    execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "a program at the top"], { stdio: "ignore" });

    // control: `.` is dropped and nothing in the working folder runs
    const dot = release(repo, `.:${SYSTEM_PATH}`, mkdtempSync(join(tmpdir(), "release-path-link-home-")), elsewhere);
    assert.match(dot.out, /1 PATH entries that are not the operator's own/);
    assert.equal(existsSync(ran), false, `control: the working folder's pnpm ran through '.':\n${dot.out}`);

    const proc = release(repo, `/proc/self/cwd:${SYSTEM_PATH}`, mkdtempSync(join(tmpdir(), "release-path-link-home-")), elsewhere);
    assert.equal(existsSync(ran), false,
      `a program in the working folder ran through the PATH entry /proc/self/cwd:\n${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${proc.out}`);
  });
});
