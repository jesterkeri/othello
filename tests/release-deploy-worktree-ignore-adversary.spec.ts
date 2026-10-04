/**
 * Adversary (647e485): every git call of the release goes through gitIn, which must answer "only about the release
 * root's own files against its own real HEAD, whatever the caller's environment or HOME contains and whatever the
 * repository's own config says" (spec for the adversary pass on 647e485; ops/trust-config.ts gitIn doc comment). The
 * stated limit covers only a repository's own `.git/info/exclude`, hooks and object store.
 *
 * 1. An untracked `.gitignore` in the working tree is read by `git status` like a committed one, and it can ignore
 *    itself. So one untracked file, written next to an unreviewed page and in no commit, hides that page and itself from
 *    `gitFor(root).changed()` (deployRecorded's "files changed since the record was written") and from trust-config
 *    --record's `status --porcelain` dirty check. It needs no access to `.git` and no config: only the same working-tree
 *    write that placed the page, which is what the check exists to catch.
 * 2. The repository's own `core.trustctime=false` (not overridden on gitIn's command line) makes git trust a tracked
 *    file's stat data without its ctime, so an in-place, same-size edit whose mtime is put back is reported clean.
 * 3. The repository's own `core.ignoreCase=true` on a case-sensitive file system makes an untracked `Page.tsx` beside a
 *    committed `page.tsx` count as the tracked file, so it is not reported.
 *
 * Nothing here contacts Vercel or a chain: temporary git repositories and gitIn/gitFor.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-worktree-ignore-adversary.spec.ts
 *
 * (Kept with the fix: trust-config --record's dirty check is now `uncommittedPaths`, git's status together with a
 * content check of the build's inputs against HEAD, so the "dirty check" assertions below name that function rather
 * than the raw `status --porcelain` it used to be.)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitFor } from "../ops/release-deploy.ts";
import { uncommittedPaths } from "../ops/trust-config.ts";
import { commitTarget } from "./fake-pinned-cli.ts";

const PAGE = "app/src/app/unreviewed/page.tsx";
const TRACKED = "app/src/app/page.tsx";
const OLD = new Date("2020-01-01T00:00:00Z");

function git(root: string, ...a: string[]): void {
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
}

/** A committed checkout: the reviewed target plus one committed page (mtime in the past, so its stat entry is not racy). */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "release-worktree-ignore-"));
  commitTarget(root, { vercelOrgId: "team_A", vercelProjectId: "prj_A" });
  mkdirSync(join(root, "app", "src", "app"), { recursive: true });
  writeFileSync(join(root, TRACKED), "export default function Page() { return 'A'; }\n");
  utimesSync(join(root, TRACKED), OLD, OLD);
  git(root, "add", TRACKED);
  git(root, "commit", "-q", "-m", "reviewed page");
  git(root, "status", "--porcelain"); // refresh the index's stat data
  return root;
}

function withUntrackedPage(root: string): void {
  mkdirSync(join(root, "app", "src", "app", "unreviewed"), { recursive: true });
  writeFileSync(join(root, PAGE), "export default function Page() { return null; }\n");
}

/**
 * Same size, same inode (written in place), mtime put back: only ctime tells it apart. git compares whole seconds of
 * ctime, so the edit waits until the recorded ctime is in the past (as it is for any file checked out earlier).
 */
function editInPlace(root: string): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  writeFileSync(join(root, TRACKED), "export default function Page() { return 'B'; }\n");
  utimesSync(join(root, TRACKED), OLD, OLD);
}

describe("adversary: what gitIn's status still hides after 647e485", () => {
  it("control: an untracked page and an in-place edit are both reported", () => {
    const root = checkout();
    withUntrackedPage(root);
    assert.deepEqual(gitFor(root).changed(), [PAGE]);
    editInPlace(root);
    assert.deepEqual(gitFor(root).changed().sort(), [TRACKED, PAGE].sort());
    writeFileSync(join(root, "app", "src", "app", "Page.tsx"), "export default function Page() { return 'C'; }\n");
    assert.deepEqual(gitFor(root).changed().sort(), [TRACKED, "app/src/app/Page.tsx", PAGE].sort());
  });

  it("an untracked, self-ignoring .gitignore beside the page (no .git access, no config): the page is still reported", () => {
    const root = checkout();
    withUntrackedPage(root);
    writeFileSync(join(root, "app", "src", "app", "unreviewed", ".gitignore"), "*\n");
    const changed = gitFor(root).changed();
    assert.notDeepEqual(changed, [],
      "gitFor(root).changed() hid an untracked page, and the untracked .gitignore that hides it, both in no commit");
    assert.notDeepEqual(uncommittedPaths(root), [],
      "trust-config --record's dirty check (uncommittedPaths) sees a clean tree");
  });

  it("the repository's own core.trustctime=false: an in-place same-size edit of a tracked page is still reported", () => {
    const root = checkout();
    git(root, "config", "core.trustctime", "false");
    editInPlace(root);
    assert.deepEqual(gitFor(root).changed(), [TRACKED],
      "gitFor(root).changed() reported a tracked page whose content differs from HEAD as unchanged");
    assert.match(uncommittedPaths(root).join("\n"), /page\.tsx/, "trust-config --record's dirty check sees a clean tree");
  });

  it("the repository's own core.ignoreCase=true: an untracked Page.tsx beside the committed page.tsx is still reported", () => {
    const root = checkout();
    git(root, "config", "core.ignoreCase", "true");
    writeFileSync(join(root, "app", "src", "app", "Page.tsx"), "export default function Page() { return 'C'; }\n");
    assert.deepEqual(gitFor(root).changed(), ["app/src/app/Page.tsx"],
      "gitFor(root).changed() hid an untracked file that differs from a tracked one only in case");
  });
});
