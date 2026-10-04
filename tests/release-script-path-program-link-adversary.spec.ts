/**
 * Adversary pass on 7afd45e (Codex r6 F1): the PATH filter now resolves each FOLDER once and checks it and its parents,
 * but the program a lookup finds in a kept folder is never looked at. A program that is a link (the operator's own
 * `~/bin/pnpm`, say) to a file in a folder others can write to without the sticky bit runs: another user replaces that
 * file, or renames it away and puts their own in its place, while the release runs. That is the same swap the folder
 * rule is there to stop (evm/ARB-FINDINGS.md F-40: "where another user could plant or swap a program"), and the same
 * link that tests/release-script-path-symlink-adversary.spec.ts refuses one level up, moved from the folder to the
 * program. On WSL a link from a Linux bin folder into /mnt/c (every folder 0777) is exactly this shape.
 *
 * The run uses a throwaway repository holding only the script, committed and clean, so it gets through every check
 * up to the first program looked up on PATH (`pnpm --version`); the planted pnpm only records that it ran.
 *
 *   npx mocha --import=tsx --timeout 120000 tests/release-script-path-program-link-adversary.spec.ts
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
  const repo = mkdtempSync(join(tmpdir(), "release-program-link-"));
  mkdirSync(join(repo, "ops"));
  copyFileSync(join(ROOT, "ops", "release-robinhood.sh"), join(repo, "ops", "release-robinhood.sh"));
  const g = (...a: string[]) => execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "only the script");
  return repo;
}

function release(repo: string, path: string, home: string) {
  const r = spawnSync("/bin/bash", [join(repo, "ops", "release-robinhood.sh")], {
    cwd: repo, encoding: "utf8", env: { PATH: path, HOME: home, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("release: a program in a kept PATH folder that links into a shared folder (adversary pass on 7afd45e)", function () {
  this.timeout(120_000);

  it("never runs, like the same program reached through a linked folder", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-program-link-shims-"));
    const ran = join(tmp, "RAN");
    const shared = join(tmp, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "pnpm"), `#!/bin/sh\necho "pnpm $*" >> ${JSON.stringify(ran)}\nexit 1\n`);
    chmodSync(join(shared, "pnpm"), 0o755);
    chmodSync(shared, 0o777); // no sticky bit: another user can rename `pnpm` away and put their own in its place

    // control: the shared folder itself on PATH is dropped, and nothing in it runs
    const direct = release(cleanThrowawayRepo(), `${shared}:${SYSTEM_PATH}`, mkdtempSync(join(tmpdir(), "release-program-link-home-")));
    assert.match(direct.out, /1 PATH entries that are not the operator's own .* are not used/);
    assert.equal(existsSync(ran), false, `control: the planted pnpm ran:\n${direct.out}`);

    // the operator's own folder (mode 755, in the operator's own folder), holding only a link to that program
    const own = join(tmp, "own-bin");
    mkdirSync(own);
    chmodSync(own, 0o755);
    symlinkSync(join(shared, "pnpm"), join(own, "pnpm"));
    const viaLink = release(cleanThrowawayRepo(), `${own}:${SYSTEM_PATH}`, mkdtempSync(join(tmpdir(), "release-program-link-home-")));
    assert.equal(existsSync(ran), false,
      `a program in a folder others can write to without the sticky bit ran, reached through a link in a kept PATH folder:\n` +
      `${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${viaLink.out}`);
  });
});
