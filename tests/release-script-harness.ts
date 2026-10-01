/**
 * A sealed environment for running the real ops/release-robinhood.sh in a spec: nothing can contact Vercel.
 * - a `node` shim on PATH turns the pull step (`release-deploy.ts --run-cli … pull`) into a no-op, and the deploy step
 *   (`release-deploy.ts --record`) into a copy of exactly the folder that would be uploaded (the fresh clone's
 *   app/.vercel/output) to `uploadedTo`, then a no-op; every other node call runs the real node;
 * - HOME is an empty temporary folder with no Vercel login in it (XDG dirs and VERCEL_TOKEN are removed); only the pnpm
 *   store, the npm cache and forge's Solidity compilers are linked into it (no credentials live there), so installs
 *   and builds reuse this machine's packages.
 *   (The release script drops every other variable itself, so the store cannot be passed as npm_config_store_dir.)
 * - where this machine's pnpm is a corepack shim (which, with an empty HOME, would fetch the newest pnpm), the pinned
 *   pnpm 10.32.1 from corepack's cache is run directly.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

export function sealedReleaseEnv(tmp: string, uploadedTo: string): NodeJS.ProcessEnv {
  const store = execFileSync("pnpm", ["store", "path"], { encoding: "utf8" }).trim(); // …/pnpm/store/v10
  const npmCache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).trim();
  const shim = join(tmp, "shim");
  mkdirSync(shim);
  writeFileSync(join(shim, "node"),
    `#!/bin/sh\ncase " $* " in\n` +
    `  *" ops/release-deploy.ts --run-cli "*" pull "*) echo "shim: pull skipped" >&2; exit 0;;\n` +
    `  *" ops/release-deploy.ts --record "*) cp -R app/.vercel/output ${JSON.stringify(uploadedTo)} && cp release/robinhood-prebuilt.json ${JSON.stringify(`${uploadedTo}.record.json`)} && echo "shim: deploy skipped" >&2; exit 0;;\n` +
    `esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(join(shim, "node"), 0o755);
  const cached = join(process.env.HOME ?? "", ".cache", "node", "corepack", "v1", "pnpm", "10.32.1", "bin", "pnpm.cjs");
  if (existsSync(cached)) {
    writeFileSync(join(shim, "pnpm"), `#!/bin/sh\nexec node ${JSON.stringify(cached)} "$@"\n`);
    chmodSync(join(shim, "pnpm"), 0o755);
  }
  const home = mkdtempSync(join(tmpdir(), "release-sealed-home-"));
  mkdirSync(join(home, ".local", "share", "pnpm"), { recursive: true });
  symlinkSync(dirname(store), join(home, ".local", "share", "pnpm", "store"));
  symlinkSync(npmCache, join(home, ".npm"));
  // forge's installed Solidity compilers (only compiler binaries), so a release that builds the contracts does not
  // download solc again
  for (const rel of [".svm", join(".local", "share", "svm")]) {
    const svm = join(process.env.HOME ?? "", rel);
    if (existsSync(svm)) symlinkSync(svm, join(home, rel));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${shim}:${process.env.PATH}`, HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("XDG_") || k.startsWith("VERCEL_") || k.startsWith("NEXT_PUBLIC_")) delete env[k];
  return env;
}

/**
 * The sealed specs link a test project ("ci-offline"); the release refuses any link but ops/release-target.json's, so
 * each spec commits a matching test target in its own clone (the release's clean-checkout check then passes and the
 * fresh clone carries it). Returns the commit.
 */
export function commitTestReleaseTarget(repo: string, orgId = "ci-offline", projectId = "ci-offline"): string {
  writeFileSync(join(repo, "ops", "release-target.json"),
    JSON.stringify({ vercelOrgId: orgId, vercelProjectId: projectId, vercelSettings: REVIEWED_SETTINGS }) + "\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...a], { encoding: "utf8" });
  git("add", "ops/release-target.json");
  git("commit", "-q", "-m", "test: release target for the sealed spec");
  return git("rev-parse", "HEAD").trim();
}
