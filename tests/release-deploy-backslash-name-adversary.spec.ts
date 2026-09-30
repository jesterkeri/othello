/**
 * Adversary (5ed06d3): "before the deploy (ops/release-deploy.ts deployRecorded, via gitFor(root).changed()), the
 * release refuses if any build input on disk differs from HEAD: a file not in HEAD, ... Build inputs: every file under
 * app/ and every file at the repository root, except NOT_SOURCE ... and the root .git. No ignore rule, index, stat
 * cache or git setting may take part." (spec for the adversary pass on 5ed06d3, point 1; ops/trust-config.ts sourceDrift
 * doc comment).
 *
 * sourceDrift reports a root file named `release\robinhood-prebuilt.json` (a backslash is an ordinary name byte on
 * Linux and macOS). deployRecorded then passes every changed path through `norm`, which turns `\` into `/`, and drops
 * what equals the record's own path: the root file becomes `release/robinhood-prebuilt.json` and is let through. git's
 * status would still list it (quoted), so the file needs one ignore rule in the repository's own `.git/info/exclude`,
 * which the spec says may not take part. trust-config --record (uncommittedPaths, no allow-list) still refuses it.
 *
 * Nothing here contacts Vercel or a chain: a temporary git repository, sourceDrift and deployRecorded with a runner
 * that fails the spec if it is ever called.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/release-deploy-backslash-name-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, gitFor } from "../ops/release-deploy.ts";
import { VERCEL_CLI, sourceDrift } from "../ops/trust-config.ts";
import { commitTarget } from "./fake-pinned-cli.ts";

function git(root: string, ...a: string[]): void {
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
}

/** A committed checkout with an app page and an unwritten-to-HEAD release record for its commit. */
function recorded(): { root: string; recordFile: string } {
  const root = mkdtempSync(join(tmpdir(), "release-backslash-"));
  commitTarget(root, { vercelOrgId: "team_A", vercelProjectId: "prj_A" });
  mkdirSync(join(root, "app", "src", "app"), { recursive: true });
  writeFileSync(join(root, "app", "src", "app", "page.tsx"), "export default function Page() { return 'A'; }\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "reviewed inputs");
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  mkdirSync(join(root, "release"));
  const recordFile = join(root, "release", "robinhood-prebuilt.json");
  writeFileSync(recordFile, JSON.stringify({ commit, vercelCli: VERCEL_CLI, fileList: "release/robinhood-prebuilt.files.txt" }));
  writeFileSync(join(root, "release", "robinhood-prebuilt.files.txt"), "");
  return { root, recordFile };
}

const neverRun = async (): Promise<never> => { throw new Error("the runner was called: the deploy went past its checks"); };

async function deploy(root: string, recordFile: string) {
  return deployRecorded({ root, recordFile, prod: false, run: neverRun as never, git: gitFor(root), env: {},
    target: { vercelOrgId: "team_A", vercelProjectId: "prj_A" } as never });
}

describe("adversary: a root file whose name holds a backslash, after 5ed06d3", () => {
  it("control: an untracked, ignored root file with an ordinary name is refused by the deploy", async () => {
    const { root, recordFile } = recorded();
    writeFileSync(join(root, "release-robinhood-prebuilt.json"), "not in any commit\n");
    appendFileSync(join(root, ".git", "info", "exclude"), "release?robinhood-prebuilt.json\n");
    assert.deepEqual(sourceDrift(root), ["release-robinhood-prebuilt.json"]);
    const r = await deploy(root, recordFile);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /^files changed since the record was written: release-robinhood-prebuilt\.json$/);
  });

  it("an untracked root file named release\\robinhood-prebuilt.json is refused by the deploy", async () => {
    const { root, recordFile } = recorded();
    const name = "release\\robinhood-prebuilt.json";
    writeFileSync(join(root, name), "not in any commit\n");
    appendFileSync(join(root, ".git", "info", "exclude"), "release?robinhood-prebuilt.json\n");
    assert.deepEqual(sourceDrift(root), [name], "precondition: the content check itself reports the root file");
    const r = await deploy(root, recordFile);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /^files changed since the record was written: /,
      `deployRecorded let a root file that is in no commit through its changed-file check (it refused later, for: ${(r as { reason: string }).reason})`);
  });
});
