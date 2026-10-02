/**
 * Adversary pass on 7afd45e (Codex r6 F1): the PATH filter checks a kept folder's OWNER (the operator or root) but
 * only the MODE of its parents. A parent owned by another user, mode 755, passes, yet its owner can write to it: they
 * rename the operator's (or root's) folder away and put their own in its place while the release runs. The stated rule
 * drops a folder "under a folder they can write to" (evm/ARB-FINDINGS.md F-40; ops/release-robinhood.sh's PATH comment),
 * and the owner of a folder can always write to it. The sticky bit does not help either: it stops others from renaming
 * an entry, never the folder's owner.
 *
 * Another user cannot be made without root here, so the spec runs the script in a user namespace that maps only the
 * operator's own uid (`unshare --map-current-user`): there every folder of the real root's shows as owned by uid 65534,
 * a user that is neither the operator nor root, so the operator's own folder under /tmp sits under a folder owned by
 * another user, exactly the case above. The script's checks read the same `stat` answer they would read for a real
 * other user. Skipped where unprivileged user namespaces are not allowed.
 *
 *   npx mocha --import=tsx --timeout 120000 tests/release-script-path-parent-owner-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

function cleanThrowawayRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "release-parent-owner-"));
  mkdirSync(join(repo, "ops"));
  copyFileSync(join(ROOT, "ops", "release-robinhood.sh"), join(repo, "ops", "release-robinhood.sh"));
  const g = (...a: string[]) => execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "only the script");
  return repo;
}

const inNamespace = (args: string[]) => spawnSync("/usr/bin/unshare", ["--map-current-user", ...args], { encoding: "utf8" });

describe("release: a PATH folder under a folder another user owns (adversary pass on 7afd45e)", function () {
  this.timeout(120_000);

  it("is dropped, so a program that user swaps in never runs", function () {
    const probe = existsSync("/usr/bin/unshare") ? inNamespace(["/usr/bin/stat", "-c", "%u %a", "/tmp"]) : undefined;
    if (!probe || probe.status !== 0) this.skip();
    const [tmpOwner, tmpMode] = probe!.stdout.trim().split(" ");
    const me = String(process.getuid!());
    // the precondition, as the script will see it: /tmp is owned by a user that is neither the operator nor root
    assert.ok(tmpOwner !== me && tmpOwner !== "0", `precondition: /tmp shows as owned by ${tmpOwner} in the namespace`);
    assert.equal(tmpMode, "1777");

    const tmp = mkdtempSync(join(tmpdir(), "release-parent-owner-shims-"));
    const ran = join(tmp, "RAN");
    const own = join(tmp, "own-bin"); // the operator's own folder, mode 755; its parents' mode bits all pass the filter
    mkdirSync(own);
    chmodSync(own, 0o755);
    writeFileSync(join(own, "pnpm"), `#!/bin/sh\necho "pnpm $*" >> ${JSON.stringify(ran)}\nexit 1\n`);
    chmodSync(join(own, "pnpm"), 0o755);

    const repo = cleanThrowawayRepo();
    const home = mkdtempSync(join(tmpdir(), "release-parent-owner-home-"));
    const r = inNamespace(["/usr/bin/env", "-i", `PATH=${own}:${SYSTEM_PATH}`, `HOME=${home}`, "LANG=C.UTF-8",
      "/bin/bash", "-c", `cd ${JSON.stringify(repo)} && exec /bin/bash ops/release-robinhood.sh`]);
    assert.equal(existsSync(ran), false,
      `a program in a folder under a folder owned by another user (uid ${tmpOwner}) ran:\n` +
      `${existsSync(ran) ? readFileSync(ran, "utf8") : ""}\n${r.stdout}\n${r.stderr}`);
  });
});
