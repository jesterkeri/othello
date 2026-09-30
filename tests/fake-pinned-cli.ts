/**
 * A folder that passes ops/release-deploy.ts verifyPinnedCli without the real CLI: the committed lockfile and a
 * `vercel` package.json at the pinned version, and a placeholder vc.js. Release specs pass its vc.js as `cli`, so each
 * still reaches the check it is about; their spy runner never executes it.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

/**
 * Unit specs build their own release folder. The deploy step refuses any link but the reviewed target (Codex r4 F1),
 * so before a spec records its release this gives it a link (app/.vercel/project.json, gitignored like the real one)
 * when it has none, and returns the target matching the spec's link, which the spec passes to deployRecorded; the real
 * release never passes one and reads the committed ops/release-target.json. A link without ids is left alone (the spec
 * means it to be refused).
 */
export function reviewedTarget(root: string): { vercelOrgId: string; vercelProjectId: string } {
  const pj = join(root, "app", ".vercel", "project.json");
  if (!existsSync(pj)) {
    mkdirSync(join(root, "app", ".vercel"), { recursive: true });
    writeFileSync(pj, JSON.stringify({ projectId: "prj_TEST", orgId: "team_TEST", settings: {} }));
  }
  let link: { orgId?: unknown; projectId?: unknown } = {};
  try { link = JSON.parse(readFileSync(pj, "utf8")); } catch { /* unreadable: the spec means it to be refused */ }
  return {
    vercelOrgId: typeof link.orgId === "string" ? link.orgId : "team_TEST",
    vercelProjectId: typeof link.projectId === "string" ? link.projectId : "prj_TEST",
  };
}
