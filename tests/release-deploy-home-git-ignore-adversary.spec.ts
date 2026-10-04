/**
 * Adversary (49ec527): every git call of the release goes through gitIn, which must answer only about the release
 * root's own repository, with "no system or global git config" (ops/trust-config.ts gitIn doc comment; spec for the
 * adversary pass on 9b44681). gitIn sets GIT_CONFIG_GLOBAL=/dev/null but still passes the caller's HOME, and git reads
 * the user-global excludes file $HOME/.config/git/ignore (core.excludesFile's default, gitignore(5)) whether or not a
 * global config file is read. So a caller who sets HOME (or owns it) hides any untracked file from
 * `gitFor(root).changed()` (deployRecorded's "files changed since the record was written") and from trust-config
 * --record's `status --porcelain` ("untracked files count: vercel build would include an untracked page that is in no
 * commit"). The same HOME also supplies $HOME/.config/git/attributes.
 *
 * Nothing here contacts Vercel or a chain: a temporary git repository, a temporary HOME, and gitIn/gitFor.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-home-git-ignore-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitFor } from "../ops/release-deploy.ts";
import { gitIn } from "../ops/trust-config.ts";
import { commitTarget } from "./fake-pinned-cli.ts";

const PAGE = "app/src/app/unreviewed/page.tsx";

/** A committed checkout plus one untracked page that is in no commit. */
function checkoutWithUntrackedPage() {
  const root = mkdtempSync(join(tmpdir(), "release-home-ignore-"));
  commitTarget(root, { vercelOrgId: "team_A", vercelProjectId: "prj_A" });
  mkdirSync(join(root, "app", "src", "app", "unreviewed"), { recursive: true });
  writeFileSync(join(root, PAGE), "export default function Page() { return null; }\n");
  return root;
}

function withHome<T>(home: string, f: () => T): T {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return f();
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  }
}

describe("adversary: the release's git still reads the caller's HOME git ignore file", () => {
  it("control: with a HOME that holds no git files, the untracked page is reported", () => {
    const root = checkoutWithUntrackedPage();
    const home = mkdtempSync(join(tmpdir(), "release-home-ignore-home-"));
    withHome(home, () => {
      assert.deepEqual(gitFor(root).changed(), [PAGE]);
      assert.match(gitIn(root, ["status", "--porcelain"]), /\?\? app\//);
    });
  });

  it("a HOME whose .config/git/ignore names the page: the untracked page is still reported", () => {
    const root = checkoutWithUntrackedPage();
    const home = mkdtempSync(join(tmpdir(), "release-home-ignore-home-"));
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), "unreviewed/\n");
    withHome(home, () => {
      assert.deepEqual(gitFor(root).changed(), [PAGE],
        "gitFor(root).changed() (deployRecorded's changed-file check) hid an untracked page because the caller's " +
        "HOME holds a global git ignore file");
      assert.match(gitIn(root, ["status", "--porcelain"]), /\?\? app\//,
        "trust-config --record's dirty check (gitIn status --porcelain) sees a clean tree");
    });
  });
});
