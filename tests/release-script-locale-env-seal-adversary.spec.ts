/**
 * Adversary test on 7552f17 (requirement 1: no locale the release keeps, LANG and LC_ALL among them, can change how the
 * release matches or parses any tool's output, so every refusal holds under any LANG/LC_ALL the caller has).
 *
 * 7552f17 exports LC_ALL=C "right after the environment seal", but the seal's own check is the parse it leaves in the
 * caller's locale: `env | cut -d= -f1 | grep -vxE "<allowed>|..."`. The flag RELEASE_ENV_SEALED is not trusted (the
 * script says so), so a caller may start the script already "sealed". bash passes an environment entry whose name is
 * not valid UTF-8 through to its children unchanged, and in a UTF-8 locale GNU grep suppresses an output line that is
 * not valid UTF-8 ("binary file matches" on stderr). So an extra entry named `\xffX` is refused under LC_ALL=C and passes
 * the check under LC_ALL=C.UTF-8: the outcome of the refusal depends on the caller's locale.
 *
 * The script runs from a throwaway repository holding only ops/release-robinhood.sh and one untracked file, so a run
 * that gets past the seal stops at the clean-checkout check: no install, no build, no Vercel.
 *
 *   npx mocha --import=tsx --timeout 120000 tests/release-script-locale-env-seal-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEAL_REFUSAL = /release: the environment holds more than the release allows/;
const STATUS_REFUSAL = /release: commit, discard or remove changes and untracked files first/;

function throwawayRepo() {
  const tmp = mkdtempSync(join(tmpdir(), "release-locale-seal-"));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, "ops"), { recursive: true });
  copyFileSync(join(ROOT, "ops", "release-robinhood.sh"), join(repo, "ops", "release-robinhood.sh"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", "ops/release-robinhood.sh"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "script only"]);
  writeFileSync(join(repo, "untracked.txt"), "stops the run at the clean-checkout check\n");
  const home = join(tmp, "home");
  mkdirSync(home);
  return { repo, home };
}

/** The script started already "sealed", with one extra entry whose name is the bytes 0xff 'X'. */
function run(repo: string, home: string, locale: string, extraName: boolean) {
  // node would encode a string key as UTF-8, so the raw byte is put in by env(1) from printf's output
  const inject = extraName ? 'exec env "$(printf "\\377X=1")" bash "$0"' : 'exec bash "$0"';
  const r = spawnSync("bash", ["-c", inject, join(repo, "ops", "release-robinhood.sh")], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { RELEASE_ENV_SEALED: "1", PATH: process.env.PATH, HOME: home, LANG: locale, LC_ALL: locale },
  });
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status };
}

describe("release: the environment seal does not depend on the locale (adversary on 7552f17)", () => {
  it("an extra environment entry with a non-UTF-8 name is refused under LC_ALL=C.UTF-8 as under LC_ALL=C", () => {
    const { repo, home } = throwawayRepo();

    // control: without the extra entry the seal passes in both locales and the run stops at the status check
    for (const l of ["C", "C.UTF-8"]) {
      const ok = run(repo, home, l, false);
      assert.doesNotMatch(ok.out, SEAL_REFUSAL, `precondition: a plain sealed run passes the seal under ${l}:\n${ok.out}`);
      assert.match(ok.out, STATUS_REFUSAL, `precondition: a plain sealed run stops at the status check under ${l}:\n${ok.out}`);
    }

    // control: in the C locale the seal refuses the extra entry
    const c = run(repo, home, "C", true);
    assert.match(c.out, SEAL_REFUSAL, `precondition: under LC_ALL=C the seal refuses the extra entry (exit ${c.status}):\n${c.out}`);

    // the defect: in a UTF-8 locale grep drops the name's line and the seal passes
    const u = run(repo, home, "C.UTF-8", true);
    assert.match(u.out, SEAL_REFUSAL,
      `under LC_ALL=C.UTF-8 the environment seal passed an extra entry it refuses under LC_ALL=C (exit ${u.status}):\n${u.out}`);
  });
});
