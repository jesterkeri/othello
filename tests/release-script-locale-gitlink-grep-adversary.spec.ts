/**
 * Adversary test on 86afb72 (requirement 1: every git call of the release path is matched AND PARSED in a way that no
 * locale the release keeps, LANG and LC_ALL among them, can change).
 *
 * 86afb72 runs git itself in the C locale (safe_git's LC_ALL=C), but ops/release-robinhood.sh parses git's output with
 * grep in the caller's locale: `printf '%s\n%s\n' "$tree" "$index" | grep '^160000 ' | ... | grep -v '^evm/lib/'`.
 * A repository's own config may set core.quotePath=false (nothing refuses or overrides it), and then ls-tree and
 * ls-files print a path as its raw bytes. In a UTF-8 locale (Ubuntu's default, LANG=C.UTF-8) GNU grep suppresses every
 * output line that is not valid UTF-8 ("binary file matches" on stderr), so a gitlink outside evm/lib/ at a path holding
 * the byte 0xff is dropped and the nested-repository check passes. In the C locale the same checkout is refused there.
 * So the outcome of the check depends on the locale.
 *
 * The gitlink is committed with git itself (an uninitialised nested repository, an empty folder on disk); nothing
 * outside the test's temporary folder is written.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-locale-gitlink-grep-adversary.spec.ts
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
const REFUSAL = /release: a nested repository outside evm\/lib\//;

/** A clone of this repository's HEAD set up as the release expects, with a committed gitlink at `vendor\xff`. */
function plantedCheckout() {
  const tmp = mkdtempSync(join(tmpdir(), "release-locale-gitlink-"));
  const repo = join(tmp, "repo");
  execFileSync("git", ["clone", "--quiet", ROOT, repo]);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
  appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
  mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
  writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
  commitTestReleaseTarget(repo);

  const ident = ["-c", "user.name=t", "-c", "user.email=t@t.invalid"];
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const path = Buffer.concat([Buffer.from("vendor"), Buffer.from([0xff])]);
  // an uninitialised nested repository: the gitlink in the index and HEAD, an empty folder on disk
  mkdirSync(Buffer.concat([Buffer.from(repo + "/"), path]));
  // the index entry is written from raw bytes (a JavaScript string argument would be re-encoded as UTF-8)
  execFileSync("git", ["-C", repo, "update-index", "--add", "-z", "--index-info"],
    { input: Buffer.concat([Buffer.from(`160000 ${head}\t`), path, Buffer.from([0])]) });
  execFileSync("git", ["-C", repo, ...ident, "commit", "-q", "-m", "test: a gitlink outside evm/lib/ at a non-UTF-8 path"]);
  // the repository's own setting: paths printed as their bytes
  execFileSync("git", ["-C", repo, "config", "core.quotePath", "false"]);
  return { tmp, repo, path };
}

function release(tmp: string, repo: string, locale: string) {
  const uploaded = join(tmp, `uploaded-${locale}`);
  const env = { ...sealedReleaseEnv(mkdtempSync(join(tmp, `env-${locale}-`)), uploaded), LANG: locale, LC_ALL: locale };
  const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout}\n${r.stderr}`;
  return { out, status: r.status, deployed: existsSync(uploaded), tail: out.split("\n").filter(Boolean).slice(-10).join("\n") };
}

describe("release: the nested-repository check does not depend on the locale (adversary on 86afb72)", function () {
  this.timeout(900_000);

  it("a gitlink outside evm/lib/ at a non-UTF-8 path is refused at the script's check under LC_ALL=C.UTF-8 as under LC_ALL=C", () => {
    const { tmp, repo, path } = plantedCheckout();

    // not vacuous: HEAD and the index hold the gitlink at the raw path, and the checkout reads as clean
    const tree = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", "HEAD"]);
    assert.ok(tree.includes(Buffer.concat([Buffer.from("\t"), path, Buffer.from([0])])) && tree.includes(Buffer.from("160000 commit ")),
      "precondition: HEAD holds the gitlink at vendor\\xff");
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], { encoding: "utf8" }), "",
      "precondition: the checkout reads as clean");

    // control: in the C locale the script's own check refuses the checkout
    const c = release(tmp, repo, "C");
    assert.match(c.out, REFUSAL, `precondition: under LC_ALL=C the script refuses the gitlink (exit ${c.status}):\n${c.tail}`);

    // the defect: in a UTF-8 locale grep drops the line and the check passes
    const u = release(tmp, repo, "C.UTF-8");
    assert.match(u.out, REFUSAL,
      `under LC_ALL=C.UTF-8 the script's nested-repository check passed a gitlink outside evm/lib/ that it refuses under LC_ALL=C ` +
      `(release exit ${u.status}, deployed ${u.deployed}):\n${u.tail}`);
  });
});
