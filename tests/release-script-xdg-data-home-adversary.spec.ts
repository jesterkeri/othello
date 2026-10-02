/**
 * Adversary pass on 4d9fcdd: the release drops every PATH folder that is not the operator's own (another user's, or one
 * group or others can write to), but it keeps the caller's XDG_DATA_HOME through the seal (ALLOWED_ENV) and never
 * judges the folder it names. Tools look up programs there: forge runs the Solidity compiler from
 * `$XDG_DATA_HOME/svm/<version>/solc-<version>` (svm's data folder when ~/.svm does not exist), so with XDG_DATA_HOME in
 * a folder others can write to, a solc another user planted runs at the release's `forge build --force` step (reached
 * whenever TRUSTED_FACTORY is set). The trust boundary (evm/ARB-FINDINGS.md F-40): nothing that is not the operator's
 * own (another user's file or folder, anything writable by group or others) may run.
 *
 * The run uses the sealed harness (no Vercel login, pull and deploy stubbed; the release stops at forge, long before
 * either). The throwaway clone commits a set TRUSTED_FACTORY (a syntactically valid literal; nothing reads it on chain
 * before forge) and replaces evm/ with a one-contract project at the repository's solc version, with no submodules, so
 * the step needs no network. The planted solc only records that it ran.
 *
 *   npx mocha --import=tsx --timeout 900000 tests/release-script-xdg-data-home-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTestReleaseTarget, sealedReleaseEnv } from "./release-script-harness.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";
import { replaceTrustedFactory } from "./config-fixture.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOLC = "0.8.30"; // evm/foundry.toml solc_version

describe("release: XDG_DATA_HOME in a folder others can write to (adversary pass on 4d9fcdd)", function () {
  this.timeout(900_000);

  it("never runs a program another user planted there", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-xdg-data-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", ROOT, repo]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    symlinkSync(join(ROOT, "app", "node_modules"), join(repo, "app", "node_modules"));
    appendFileSync(join(repo, ".git", "info", "exclude"), "node_modules\napp/node_modules\n");
    mkdirSync(join(repo, "app", ".vercel"), { recursive: true });
    writeFileSync(join(repo, "app", ".vercel", "project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: REVIEWED_SETTINGS }));
    commitTestReleaseTarget(repo);

    // a set TRUSTED_FACTORY, so the release builds the contracts; evm/ is one contract and no submodule (no network)
    const g = (...a: string[]) => execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
    const config = join(repo, "app", "src", "lib", "robinhood", "config.ts");
    const src = readFileSync(config, "utf8");
    const set = replaceTrustedFactory(src,
      `export const TRUSTED_FACTORY: TrustedFactory | null = Object.freeze({ address: "0x000000000000000000000000000000000000dead", codeHash: "0x${"ab".repeat(32)}" });`);
    assert.notEqual(set, src, "config.ts no longer has the expected null line");
    writeFileSync(config, set);
    g("rm", "-r", "-q", "evm", ".gitmodules");
    rmSync(join(repo, "evm"), { recursive: true, force: true });
    mkdirSync(join(repo, "evm", "src"), { recursive: true });
    writeFileSync(join(repo, "evm", "foundry.toml"), `[profile.default]\nsrc = "src"\nout = "out"\nsolc_version = "${SOLC}"\noffline = true\n`);
    writeFileSync(join(repo, "evm", "src", "A.sol"), `// SPDX-License-Identifier: MIT\npragma solidity ${SOLC};\ncontract A {}\n`);
    g("add", "-A"); g("commit", "-q", "-m", "test: a set factory and a one-contract evm");

    // the folder XDG_DATA_HOME names: writable by others, no sticky bit (like WSL's /mnt/c, or a shared folder); it holds
    // this machine's pnpm store (linked, so installs stay offline) and a solc another user planted
    const ran = join(tmp, "PLANTED-SOLC-RAN");
    const shared = join(tmp, "shared");
    const planted = join(shared, "svm", SOLC, `solc-${SOLC}`);
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, `#!/bin/sh\necho "planted solc $*" >> ${JSON.stringify(ran)}\nexit 1\n`);
    chmodSync(planted, 0o755);
    const store = execFileSync("pnpm", ["store", "path"], { encoding: "utf8" }).trim();
    mkdirSync(join(shared, "pnpm"), { recursive: true });
    symlinkSync(dirname(store), join(shared, "pnpm", "store"));
    chmodSync(shared, 0o777);

    const env: NodeJS.ProcessEnv = { ...sealedReleaseEnv(tmp, join(tmp, "uploaded-output")), XDG_DATA_HOME: shared };
    const r = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.split("\n").filter(Boolean).slice(-15).join("\n");

    // the release itself counts that folder as not the operator's own: named on PATH, it is dropped (an untracked file
    // stops this run at the clean-checkout check)
    writeFileSync(join(repo, "untracked.txt"), "stops the control run at the clean-checkout check\n");
    const pathEnv: NodeJS.ProcessEnv = { ...env, PATH: `${shared}:${env.PATH}` };
    delete pathEnv.XDG_DATA_HOME;
    const asPath = spawnSync("bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8", env: pathEnv, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(`${asPath.stdout}\n${asPath.stderr}`, /not using PATH entry ".*shared" \(another user's/);

    assert.equal(existsSync(ran), false,
      `a solc in a folder others can write to (XDG_DATA_HOME=${shared}) ran at the release's forge step (release exit ${r.status}):\n` +
      `${existsSync(ran) ? readFileSync(ran, "utf8").split(" --")[0] : ""}\n${tail}`);
    // not vacuous: the release stopped because of that folder, before any tool ran
    assert.notEqual(r.status, 0);
    assert.match(out, /release: XDG_DATA_HOME \(.*shared\) is not a folder of the operator's own/);
  });

  it("a HOME, XDG_CONFIG_HOME or NVM_DIR others can write to stops the release too; the operator's own folders do not", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-xdg-dirs-"));
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "ops"), { recursive: true });
    writeFileSync(join(repo, "ops", "release-robinhood.sh"), readFileSync(join(ROOT, "ops", "release-robinhood.sh")));
    const g = (...a: string[]) => execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdio: "ignore" });
    g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "only the script");
    writeFileSync(join(repo, "untracked.txt"), "stops the release at its clean-checkout check\n");
    const own = join(tmp, "own"); mkdirSync(own, { mode: 0o700 });
    const open = join(tmp, "open"); mkdirSync(open); chmodSync(open, 0o777);
    const run = (extra: Record<string, string>) => {
      const r = spawnSync("/bin/bash", [join(repo, "ops", "release-robinhood.sh")], { cwd: repo, encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: own, LANG: "C.UTF-8", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
      return `${r.stdout}\n${r.stderr}`;
    };
    for (const v of ["HOME", "XDG_CONFIG_HOME", "NVM_DIR", "XDG_DATA_HOME"]) {
      assert.match(run({ [v]: open }), new RegExp(`release: ${v} \\(.*open\\) is not a folder of the operator's own`), v);
      assert.match(run({ [v]: join(tmp, "missing") }), new RegExp(`release: ${v} .* is not a folder of the operator's own`), `${v} missing`);
    }
    // the operator's own folders pass through to the clean-checkout check
    assert.match(run({ XDG_DATA_HOME: own, XDG_CONFIG_HOME: own, NVM_DIR: own }), /commit, discard or remove changes/);
  });
});
