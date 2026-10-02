/**
 * Adversary pass on 3429255: the PATH filter resolves each entry (`realpath -e`), judges that folder, and joins the kept
 * folders back into one string with `:`. The curated-PATH step then splits that string on `:` again. A kept folder whose
 * resolved name holds a `:` (a folder of the operator's own named `x:`, holding a path below it) therefore comes back as
 * two or more pieces, none of which was ever judged: here the second piece is a folder others can write to without the
 * sticky bit, which the filter drops when it is named directly. Its programs are linked into $WORK/bin by their path in
 * that folder (only their owner and mode are looked at, never their folder's), so another user can swap one in at any
 * time before it runs (evm/ARB-FINDINGS.md F-40 to F-43; ops/release-robinhood.sh, the PATH filter and $WORK/bin).
 *
 * The run uses a throwaway repository holding only the script, committed and clean, so it gets through every check
 * up to the first program looked up on PATH (`pnpm --version`); the planted pnpm only records that it ran.
 *
 *   npx mocha --import=tsx --timeout 120000 tests/release-script-path-colon-folder-adversary.spec.ts
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
  const repo = mkdtempSync(join(tmpdir(), "release-path-colon-"));
  mkdirSync(join(repo, "ops"));
  copyFileSync(join(ROOT, "ops", "release-robinhood.sh"), join(repo, "ops", "release-robinhood.sh"));
  const g = (...a: string[]) => execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "only the script");
  return repo;
}

function release(repo: string, path: string) {
  const home = mkdtempSync(join(tmpdir(), "release-path-colon-home-"));
  const r = spawnSync("/bin/bash", [join(repo, "ops", "release-robinhood.sh")], {
    cwd: repo, encoding: "utf8", env: { PATH: path, HOME: home, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("release: a kept PATH folder whose resolved name holds a colon (adversary pass on 3429255)", function () {
  this.timeout(120_000);

  it("is never split into folders that were not judged, so a program in a shared folder never runs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-path-colon-shims-"));
    const ran = join(tmp, "RAN");

    // a folder another user can write to without the sticky bit, holding a pnpm that only records that it ran
    const shared = join(tmp, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "pnpm"), `#!/bin/sh\necho "pnpm $*" >> ${JSON.stringify(ran)}\nexit 1\n`);
    chmodSync(join(shared, "pnpm"), 0o755);
    chmodSync(shared, 0o777);

    // control: that folder named directly is dropped, and nothing in it runs
    const direct = release(cleanThrowawayRepo(), `${shared}:${SYSTEM_PATH}`);
    assert.match(direct.out, /not using PATH entry ".*shared" \(another user's/);
    assert.equal(existsSync(ran), false, `control: the planted pnpm ran:\n${direct.out}`);

    // the operator's own folder (every level mode 755, the operator's), whose name is `x:` followed by the shared
    // folder's path, reached through the operator's own link on PATH; it holds nothing
    const colonDir = `${join(tmp, "x")}:${shared}`;
    mkdirSync(colonDir, { recursive: true });
    for (let d = colonDir; d.length > tmp.length; d = d.slice(0, d.lastIndexOf("/"))) chmodSync(d, 0o755);
    const link = join(tmp, "own-bin");
    symlinkSync(colonDir, link);

    // (keeping that folder whole, or dropping it, both pass; only running what is in the shared folder fails)
    const viaColon = release(cleanThrowawayRepo(), `${link}:${SYSTEM_PATH}`);
    assert.equal(existsSync(ran), false,
      `a program in a folder others can write to without the sticky bit ran: the kept folder ${JSON.stringify(colonDir)} ` +
      `was split on its colon when $WORK/bin was built (release exit ${viaColon.status}):\n` +
      `${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${viaColon.out}`);
  });
});
