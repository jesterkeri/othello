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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERCEL_CLI, artifactDigest, type ReleaseRecord } from "./trust-config.ts";

export type Run = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
export type Git = { head(): string; changed(): string[] };
export type DeployResult = { ok: true; url: string } | { ok: false; reason: string };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** `vercel deploy` prints the deployment URL, and only that, on stdout. */
const URL_LINE = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i;
const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");

function differences(recorded: string[], now: string[]): string[] {
  const a = new Set(recorded);
  const b = new Set(now);
  return [...recorded.filter((l) => !b.has(l)).map((l) => `- ${l}`), ...now.filter((l) => !a.has(l)).map((l) => `+ ${l}`)];
}

export async function deployRecorded(d: {
  root: string; recordFile: string; prod: boolean; run: Run; git: Git; appDir?: string;
}): Promise<DeployResult> {
  const fail = (reason: string): DeployResult => ({ ok: false, reason });
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
  const before = artifactDigest(outDir, app);
  const drift = differences(recorded, before.lines);
  if (before.sha256 !== rec.artifactSha256 || drift.length) {
    return fail(`the artifact changed after it was scanned; nothing was deployed. Release again.\n${drift.slice(0, 20).join("\n")}`);
  }

  const r = await d.run("npx", ["--yes", `vercel@${VERCEL_CLI}`, "deploy", "--prebuilt", ...(d.prod ? ["--prod"] : [])], app);
  const url = r.stdout.split("\n").map((l) => l.trim()).filter((l) => URL_LINE.test(l)).at(-1);
  if (r.code !== 0 || !url) return fail(`vercel deploy failed (exit ${r.code}${url ? "" : ", no deployment URL printed"}); the record is unchanged`);

  const after = artifactDigest(outDir, app);
  if (after.sha256 !== rec.artifactSha256) {
    return fail(
      `files changed while they were uploading, so ${url} may not be the scanned artifact. Do not use or share it; ` +
        `remove it (npx vercel@${VERCEL_CLI} remove ${url}) and release again.\n${differences(recorded, after.lines).slice(0, 20).join("\n")}`,
    );
  }
  const done: ReleaseRecord = { ...rec, deploymentUrl: url, target: d.prod ? "production" : "preview", deployedAt: new Date().toISOString() };
  writeFileSync(d.recordFile, JSON.stringify(done, null, 2) + "\n");
  return { ok: true, url };
}

/** Real runner: progress and prompts on the terminal (stderr, stdin); stdout captured for the URL and echoed. */
const run: Run = (cmd, args, cwd) =>
  new Promise((done, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["inherit", "pipe", "inherit"] });
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
