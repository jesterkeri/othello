/**
 * A sealed environment for running the real ops/release-robinhood.sh in a spec: nothing can contact Vercel.
 * - an `npx` shim turns the pull step into a no-op, and the deploy step into a copy of exactly the folder that would be
 *   uploaded (the fresh clone's app/.vercel/output) to `uploadedTo`, then a no-op;
 * - HOME is an empty temporary folder, and XDG dirs and VERCEL_TOKEN are removed, so no Vercel login is reachable;
 * - pnpm and npm reuse this machine's package store and cache (no credentials live there), so installs are fast;
 * - where this machine's pnpm is a corepack shim (which, with an empty HOME, would fetch the newest pnpm), the pinned
 *   pnpm 10.32.1 from corepack's cache is run directly.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function sealedReleaseEnv(tmp: string, uploadedTo: string): NodeJS.ProcessEnv {
  const realNpx = execFileSync("sh", ["-c", "command -v npx"], { encoding: "utf8" }).trim();
  const store = execFileSync("pnpm", ["store", "path"], { encoding: "utf8" }).trim();
  const npmCache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).trim();
  const shim = join(tmp, "shim");
  mkdirSync(shim);
  writeFileSync(join(shim, "npx"),
    `#!/bin/sh\ncase " $* " in\n` +
    `  *" ops/release-deploy.ts --run-cli "*" pull "*) echo "shim: pull skipped" >&2; exit 0;;\n` +
    `  *" ops/release-deploy.ts --record "*) cp -R app/.vercel/output ${JSON.stringify(uploadedTo)} && echo "shim: deploy skipped" >&2; exit 0;;\n` +
    `esac\nexec ${JSON.stringify(realNpx)} "$@"\n`);
  chmodSync(join(shim, "npx"), 0o755);
  const cached = join(process.env.HOME ?? "", ".cache", "node", "corepack", "v1", "pnpm", "10.32.1", "bin", "pnpm.cjs");
  if (existsSync(cached)) {
    writeFileSync(join(shim, "pnpm"), `#!/bin/sh\nexec node ${JSON.stringify(cached)} "$@"\n`);
    chmodSync(join(shim, "pnpm"), 0o755);
  }
  const home = mkdtempSync(join(tmpdir(), "release-sealed-home-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${shim}:${process.env.PATH}`, HOME: home, VERCEL_TELEMETRY_DISABLED: "1",
    npm_config_store_dir: store, npm_config_cache: npmCache,
  };
  for (const k of Object.keys(env)) if (k.startsWith("XDG_") || k.startsWith("VERCEL_TOKEN") || k.startsWith("NEXT_PUBLIC_")) delete env[k];
  return env;
}
