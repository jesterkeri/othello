/**
 * Adversary (3b651eb): the release "must not refuse a legitimate release: the sealed script's clone after `pnpm
 * install`, `forge build`, `vercel pull`/`build`; a linked git worktree; CI's checkout" (spec for the adversary pass on
 * 3b651eb, point 4; evm/ARB-FINDINGS.md F-22 also states that in a linked worktree "HEAD, top, status and the committed
 * target all resolve").
 *
 * sourceDrift checks every non-directory entry at the repository root against HEAD. In a linked worktree (`git worktree
 * add`, which is how this repository's own checkouts are made) the root's `.git` is a FILE ("gitdir: ..."), not a
 * directory, and no commit holds it. So sourceDrift reports `.git` on a clean, committed worktree, and with it
 * uncommittedPaths (trust-config --record's dirty check) and gitFor(root).changed() (deployRecorded's "files changed
 * since the record was written"): both entry points refuse every release run from a linked worktree.
 *
 * Nothing here contacts Vercel or a chain: a temporary git repository, one linked worktree, sourceDrift and gitFor.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-linked-worktree-gitfile-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitFor } from "../ops/release-deploy.ts";
import { sourceDrift, uncommittedPaths } from "../ops/trust-config.ts";
import { commitTarget } from "./fake-pinned-cli.ts";

function git(root: string, ...a: string[]): void {
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
}

/** A committed repository with an app page and a root file, and a clean linked worktree of its HEAD. */
function linkedWorktree(): { main: string; wt: string } {
  const main = mkdtempSync(join(tmpdir(), "release-linked-main-"));
  commitTarget(main, { vercelOrgId: "team_A", vercelProjectId: "prj_A" });
  mkdirSync(join(main, "app", "src", "app"), { recursive: true });
  writeFileSync(join(main, "app", "src", "app", "page.tsx"), "export default function Page() { return 'A'; }\n");
  writeFileSync(join(main, "README.md"), "readme\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "reviewed inputs");
  const wt = join(mkdtempSync(join(tmpdir(), "release-linked-wt-")), "checkout");
  git(main, "worktree", "add", "-q", "--detach", wt, "HEAD");
  return { main, wt };
}

describe("adversary: a linked git worktree's .git file after 3b651eb", () => {
  it("control: the main checkout of the same commit is clean", () => {
    const { main } = linkedWorktree();
    assert.ok(lstatSync(join(main, ".git")).isDirectory());
    assert.deepEqual(sourceDrift(main), []);
    assert.deepEqual(gitFor(main).changed(), []);
  });

  it("a clean linked worktree of the committed HEAD is not reported as changed", () => {
    const { wt } = linkedWorktree();
    assert.ok(lstatSync(join(wt, ".git")).isFile(), "precondition: a linked worktree's .git is a gitdir file");
    assert.equal(execFileSync("git", ["-C", wt, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "",
      "precondition: git itself calls the worktree clean");
    assert.deepEqual(sourceDrift(wt), [], "sourceDrift reported a clean, committed linked worktree as drifted");
    assert.deepEqual(uncommittedPaths(wt), [], "trust-config --record's dirty check refuses a clean linked worktree");
    assert.deepEqual(gitFor(wt).changed(), [], "the deploy's changed-file check refuses a clean linked worktree");
  });
});
