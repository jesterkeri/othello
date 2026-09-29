/**
 * Deploys the recorded prebuilt Robinhood artifact, and nothing else (Codex code review r3 M1: the record must bind
 * what Vercel receives, not only what was scanned earlier). ops/release-robinhood.sh runs it straight after
 * trust-config writes the record; Joshua runs that script with his own Vercel login.
 *
 *   npx tsx ops/release-deploy.ts --record release/robinhood-prebuilt.json [--prod]
 *
 * In order, refusing before Vercel is contacted if any step fails:
 *   1. the record is new (no deployment yet) and was built with the pinned Vercel CLI;
 *   2. the checkout is the recorded commit, with nothing changed except the record and its file list;
 *   3. the exact upload set (app/.vercel/output plus every filePathMap file, as trust-config's uploadSet reads it) is
 *      hashed again and must equal the record's digest and per-file list.
 * Then the pinned CLI deploys it; the set is hashed once more (a change during the upload voids the deployment); only
 * then is the deployment URL written into the record, which is committed and reviewed with it.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERCEL_CLI, artifactDigest, cliExtraUploads, uploadSet, type ReleaseRecord } from "./trust-config.ts";

export type Run = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
export type Git = { head(): string; changed(): string[] };
export type DeployResult = { ok: true; url: string } | { ok: false; reason: string };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** `vercel deploy` prints the deployment URL, and only that, on stdout: https://<name>-<hash>-<scope>.vercel.app */
const URL_LINE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");

function differences(recorded: string[], now: string[]): string[] {
  const a = new Set(recorded);
  const b = new Set(now);
  return [...recorded.filter((l) => !b.has(l)).map((l) => `- ${l}`), ...now.filter((l) => !a.has(l)).map((l) => `+ ${l}`)];
}

/** These re-target the CLI at another project or team than the recorded `.vercel/project.json`: refused. */
export const RETARGETING_ENV = ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"];
/** The only variables the deploy CLI is given; every other VERCEL_* switch (experimental modes, overrides) is dropped. */
const PASSED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NVM_DIR", "NVM_BIN"];
export function deployEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { VERCEL_TELEMETRY_DISABLED: "1" };
  for (const k of PASSED_ENV) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/**
 * What at the repository root (or on the CLI's path) can change how the pinned CLI resolves its project, checked by
 * name so neither .gitignore nor .git/info/exclude hides it: a root `.vercel` or a root Vercel config of any name (the
 * CLI's `resolveProjectCwd` turns services mode on from the git root's vercel.json/toml/ts and then ignores
 * app/.vercel/project.json; a vercel.ts is compiled with the root .env files loaded), and a local `vercel` package that
 * `npx vercel@59.11.7` would run instead of the pinned one from the registry.
 */
export function repoRootRefusals(root: string, app: string): string[] {
  const found: string[] = [];
  if (existsSync(join(root, ".vercel"))) found.push(".vercel at the repository root: the release never writes one; remove it");
  for (const n of readdirSync(root)) if (/^(vercel|now)\.[^.]+$/i.test(n)) found.push(`${n} at the repository root: a Vercel config there moves the CLI's project root; remove it`);
  for (const dir of [root, app]) {
    for (const p of [join(dir, "node_modules", "vercel"), join(dir, "node_modules", ".bin", "vercel")]) {
      if (existsSync(p)) found.push(`${relative(root, p)}: a local Vercel CLI that npx would run instead of the pinned one; remove it`);
    }
  }
  return found;
}

export async function deployRecorded(d: {
  root: string; recordFile: string; prod: boolean; run: Run; git: Git; appDir?: string; env?: NodeJS.ProcessEnv;
}): Promise<DeployResult> {
  const fail = (reason: string): DeployResult => ({ ok: false, reason });
  const retarget = RETARGETING_ENV.filter((k) => (d.env ?? process.env)[k]);
  if (retarget.length) return fail(`${retarget.join(", ")} set in the environment would deploy to another project than the recorded one; unset it`);
  const app = d.appDir ?? join(d.root, "app");
  const outDir = join(app, ".vercel", "output");
  if (!existsSync(d.recordFile)) return fail(`no release record at ${d.recordFile}; run ops/release-robinhood.sh`);
  const rec = JSON.parse(readFileSync(d.recordFile, "utf8")) as ReleaseRecord;
  if (rec.deploymentUrl) return fail(`this record was already deployed to ${rec.deploymentUrl}; build a new release`);
  if (rec.vercelCli !== VERCEL_CLI) return fail(`the record was built with Vercel CLI ${rec.vercelCli}; this deploy pins ${VERCEL_CLI}`);
  const head = d.git.head();
  if (head !== rec.commit) return fail(`the checkout is ${head}, but the record was built from ${rec.commit}`);
  const allowed = new Set([norm(relative(d.root, d.recordFile)), norm(rec.fileList)]);
  const other = d.git.changed().map(norm).filter((p) => !allowed.has(p));
  if (other.length) return fail(`files changed since the record was written: ${other.join(", ")}`);
  const listFile = resolve(d.root, rec.fileList);
  if (!existsSync(listFile)) return fail(`the record's file list ${rec.fileList} is missing`);
  const recorded = readFileSync(listFile, "utf8").split("\n").filter(Boolean);
  if (!existsSync(outDir)) return fail(`no build at ${outDir}`);
  const extra = [...repoRootRefusals(d.root, app), ...cliExtraUploads(app), ...uploadSet(outDir, app).failures];
  if (extra.length) return fail(`the deploy would upload files the scan never covered; nothing was deployed:\n${extra.join("\n")}`);
  const before = artifactDigest(outDir, app);
  const drift = differences(recorded, before.lines);
  if (before.sha256 !== rec.artifactSha256 || drift.length) {
    return fail(`the artifact changed after it was scanned; nothing was deployed. Release again.\n${drift.slice(0, 20).join("\n")}`);
  }

  const r = await d.run("npx", ["--yes", `vercel@${VERCEL_CLI}`, "deploy", "--prebuilt", ...(d.prod ? ["--prod"] : [])], app);
  const urls = [...new Set(r.stdout.split("\n").map((l) => l.trim()).filter((l) => URL_LINE.test(l)))];
  if (r.code !== 0 || urls.length !== 1) {
    const why = urls.length > 1 ? `, several deployment URLs printed (${urls.join(", ")})` : urls.length ? "" : ", no deployment URL printed";
    return fail(`vercel deploy failed (exit ${r.code}${why}); the record is unchanged`);
  }
  const url = urls[0]!;

  const after = artifactDigest(outDir, app);
  const lateExtra = [...repoRootRefusals(d.root, app), ...cliExtraUploads(app), ...uploadSet(outDir, app).failures];
  if (after.sha256 !== rec.artifactSha256 || lateExtra.length) {
    const undo = d.prod
      ? `it is already live in production: roll back now (npx vercel@${VERCEL_CLI} rollback) and release again`
      : `do not use or share it; remove it (npx vercel@${VERCEL_CLI} remove ${url}) and release again`;
    return fail(
      `files changed while they were uploading, so ${url} may not be the scanned artifact; ${undo}.\n` +
        [...lateExtra, ...differences(recorded, after.lines)].slice(0, 20).join("\n"),
    );
  }
  const done: ReleaseRecord = { ...rec, deploymentUrl: url, target: d.prod ? "production" : "preview", deployedAt: new Date().toISOString() };
  writeFileSync(d.recordFile, JSON.stringify(done, null, 2) + "\n");
  return { ok: true, url };
}

/** Real runner: progress and prompts on the terminal (stderr, stdin); stdout captured for the URL and echoed. */
const run: Run = (cmd, args, cwd) =>
  new Promise((done, reject) => {
    const p = spawn(cmd, args, { cwd, env: deployEnv(process.env), stdio: ["inherit", "pipe", "inherit"] });
    let stdout = "";
    p.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      process.stdout.write(b);
    });
    p.on("error", reject);
    p.on("close", (code) => done({ code: code ?? 1, stdout }));
  });

const git = (root: string): Git => ({
  head: () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  changed: () =>
    execFileSync("git", ["-C", root, "status", "--porcelain", "--no-renames", "--untracked-files=all"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3)),
});

async function main() {
  const at = process.argv.indexOf("--record");
  const file = at > 0 ? process.argv[at + 1] : undefined;
  if (!file) throw new Error("--record needs the release record, e.g. release/robinhood-prebuilt.json");
  const r = await deployRecorded({ root: ROOT, recordFile: resolve(ROOT, file), prod: process.argv.includes("--prod"), run, git: git(ROOT) });
  if (!r.ok) {
    console.error(`release-deploy REFUSED: ${r.reason}`);
    process.exit(1);
  }
  console.log(`release-deploy: deployed ${r.url}; recorded in ${file}. Commit the record and its file list.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("release-deploy FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
