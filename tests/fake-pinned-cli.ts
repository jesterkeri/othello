/**
 * A folder that passes ops/release-deploy.ts verifyPinnedCli without the real CLI: the committed lockfile and a
 * `vercel` package.json at the pinned version, and a placeholder vc.js. Release specs pass its vc.js as `cli`, so each
 * still reaches the check it is about; their spy runner never executes it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERCEL_CLI } from "../ops/trust-config.ts";

let made: string | undefined;

export function fakePinnedCli(): string {
  if (made) return made;
  const dir = mkdtempSync(join(tmpdir(), "pinned-cli-"));
  copyFileSync(fileURLToPath(new URL("../ops/vercel-cli/package-lock.json", import.meta.url)), join(dir, "package-lock.json"));
  const pkg = join(dir, "node_modules", "vercel");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vercel", version: VERCEL_CLI }));
  writeFileSync(join(pkg, "dist", "vc.js"), "// stands in for the pinned CLI in tests; never run\n");
  made = realpathSync(join(pkg, "dist", "vc.js"));
  return made;
}
