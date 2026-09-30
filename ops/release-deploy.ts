/**
 * Deploys the recorded prebuilt Robinhood artifact, and nothing else (Codex code review r3 M1: the record must bind
 * what Vercel receives, not only what was scanned earlier). ops/release-robinhood.sh runs it straight after
 * trust-config writes the record; Joshua runs that script with his own Vercel login.
 *
 *   npx tsx ops/release-deploy.ts --install-cli <empty dir>        prints the path of the verified pinned CLI
 *   npx tsx ops/release-deploy.ts --preflight                      the repo-root and app/.vercel refusals, before a build
 *   npx tsx ops/release-deploy.ts --run-cli <vc.js> --cwd app -- pull|build …   the release's pull or build, checked (RUNNABLE)
 *   npx tsx ops/release-deploy.ts --record release/robinhood-prebuilt.json --cli <that path> [--prod]
 *
 * In order, refusing before Vercel is contacted if any step fails:
 *   1. the record is new (no deployment yet) and was built with the pinned Vercel CLI;
 *   2. the checkout is the recorded commit, with nothing changed except the record and its file list;
 *   3. the exact upload set (app/.vercel/output plus every filePathMap file, as trust-config's uploadSet reads it) is
 *      hashed again and must equal the record's digest and per-file list.
 * Then the pinned CLI deploys it; the set is hashed once more (a change during the upload voids the deployment); only
 * then is the deployment URL written into the record, which is committed and reviewed with it.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERCEL_CLI, VERCEL_CLI_INTEGRITY, artifactDigest, cliExtraUploads, uploadSet, type ReleaseRecord } from "./trust-config.ts";

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

const CLI_LOCK_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "vercel-cli");

/**
 * The CLI the release runs, never through npx (which prefers any `node_modules/.bin/vercel@<version>` it finds in the
 * working folder or above, and a local package, over the registry): `npm ci` of ops/vercel-cli's committed lockfile into
 * a fresh empty folder, which checks every package's registry integrity, then `node <folder>/node_modules/vercel/dist/
 * vc.js`. verifyPinnedCli proves the folder holds exactly VERCEL_CLI at VERCEL_CLI_INTEGRITY before anything runs it.
 */
export function installPinnedCli(dir: string, exec: (cmd: string, args: string[], cwd: string) => void = (c, a, cwd) => {
  execFileSync(c, a, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}): string {
  if (readdirSync(dir).length) throw new Error(`${dir} is not empty; the pinned CLI is installed into a fresh folder`);
  for (const f of ["package.json", "package-lock.json"]) copyFileSync(join(CLI_LOCK_DIR, f), join(dir, f));
  exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
  return verifyPinnedCli(dir);
}

/** The path of the pinned CLI in `dir`, or an error saying why that folder does not hold exactly the pinned CLI. */
export function verifyPinnedCli(dir: string): string {
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string; integrity?: string }> };
  const entry = lock.packages?.["node_modules/vercel"];
  if (entry?.version !== VERCEL_CLI || entry.integrity !== VERCEL_CLI_INTEGRITY) {
    throw new Error(`the CLI lock in ${dir} is not vercel@${VERCEL_CLI} with integrity ${VERCEL_CLI_INTEGRITY}`);
  }
  const committed = readFileSync(join(CLI_LOCK_DIR, "package-lock.json"), "utf8");
  if (readFileSync(join(dir, "package-lock.json"), "utf8") !== committed) throw new Error(`the CLI lock in ${dir} differs from ops/vercel-cli/package-lock.json`);
  const pkgDir = join(dir, "node_modules", "vercel");
  if (lstatSync(pkgDir).isSymbolicLink()) throw new Error(`${pkgDir} is a link`);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: string };
  if (pkg.version !== VERCEL_CLI) throw new Error(`${pkgDir} is vercel ${pkg.version}, not ${VERCEL_CLI}`);
  const bin = join(pkgDir, "dist", "vc.js");
  if (!lstatSync(bin).isFile()) throw new Error(`${bin} is not a regular file`);
  return realpathSync(bin);
}

/**
 * Names that node, pnpm, Next, PostCSS, Browserslist, Babel or TypeScript look for in the folders ABOVE a project (a
 * missing package resolves from any ancestor's node_modules; config lookups walk upward). None may exist above the
 * release's clone.
 */
const ANCESTOR_REFUSED = /^(node_modules|package\.json|pnpm-workspace\.yaml|\.pnpmfile\.cjs|postcss\.config\..*|\.postcssrc.*|\.browserslistrc|browserslist|babel\.config\..*|\.babelrc.*|\.swcrc|tsconfig\.json|jsconfig\.json|\.npmrc|\.yarnrc.*)$/;

export function ancestorRefusals(root: string): string[] {
  const found: string[] = [];
  for (let d = dirname(resolve(root)); ; d = dirname(d)) {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { found.push(`${d} (unreadable, so it cannot be checked)`); }
    for (const n of names) if (ANCESTOR_REFUSED.test(n)) found.push(`${join(d, n)}: above the release's clone, the build would read it`);
    if (dirname(d) === d) break;
  }
  return found;
}

/**
 * The reviewed deployment target (Codex r4 F1): ops/release-target.json, committed and reviewed, names the one Vercel
 * team and project the release may use; the caller's app/.vercel/project.json must name exactly those, or nothing is
 * pulled, built or deployed. (The digest only binds the link that was chosen; this checks it is the right one.)
 */
export type ReleaseTarget = { vercelOrgId?: unknown; vercelProjectId?: unknown };
export function releaseTargetRefusals(root: string, app: string, given?: ReleaseTarget): string[] {
  let target: ReleaseTarget;
  try {
    target = given ?? JSON.parse(readFileSync(join(root, "ops", "release-target.json"), "utf8"));
  } catch {
    return ["ops/release-target.json is missing or unreadable: the release has no reviewed target"];
  }
  const org = target?.vercelOrgId;
  const project = target?.vercelProjectId;
  if (typeof org !== "string" || !org || typeof project !== "string" || !project) {
    return ["ops/release-target.json must name vercelOrgId and vercelProjectId"];
  }
  let link: { orgId?: unknown; projectId?: unknown };
  try {
    link = JSON.parse(readFileSync(join(app, ".vercel", "project.json"), "utf8"));
  } catch {
    return [".vercel/project.json is missing or unreadable: link the reviewed target project first"];
  }
  if (typeof link !== "object" || link === null) return [".vercel/project.json is not a project link: link the reviewed target project first"];
  const found: string[] = [];
  if (link.orgId !== org) found.push(`.vercel/project.json orgId ${JSON.stringify(link.orgId)} is not the reviewed target ${org}`);
  if (link.projectId !== project) found.push(`.vercel/project.json projectId ${JSON.stringify(link.projectId)} is not the reviewed target ${project}`);
  return found;
}

/**
 * The refusals that must hold before the release pulls or builds anything, and again before it scans: the reviewed
 * target, above the clone, its root, app/.vercel and the link.
 */
export function preflight(root: string, target?: ReleaseTarget): string[] {
  const app = join(root, "app");
  return [...releaseTargetRefusals(root, app, target), ...ancestorRefusals(root), ...repoRootRefusals(root, app), ...cliExtraUploads(app)];
}

/**
 * The only argument lists the runner starts: the release's pull and build, word for word. Deploy goes through
 * --record alone (scanned and recorded), and no other command or global flag (--cwd, --scope, --token,
 * --local-config, --global-config) reaches the CLI.
 */
const RUNNABLE = [
  ["pull", "--yes", "--environment=preview"], ["pull", "--yes", "--environment=production"],
  ["build", "--yes"], ["build", "--yes", "--prod"],
].map((a) => JSON.stringify(a));

/**
 * Runs the verified pinned CLI (`vc.js`, checked by verifyPinnedCli) in `root`'s app folder with the deploy's
 * allow-listed environment, so pull and build get no VERCEL_*, NODE_OPTIONS, ESBUILD_* or builder-directory switch
 * either. This entry point can be run on its own, so it checks for itself: only a RUNNABLE argument list, and only
 * while every preflight refusal holds (the reviewed target first), or the CLI never starts.
 */
export function execPinnedCli(
  cliPath: string, args: string[], root: string,
  spawnIt: (cmd: string, a: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => number = (cmd, a, o) =>
    spawnSync(cmd, a, { ...o, stdio: "inherit" }).status ?? 1,
  target?: ReleaseTarget,
): number {
  if (!RUNNABLE.includes(JSON.stringify(args))) {
    throw new Error(`REFUSED: the runner starts only the release's pull or build (${RUNNABLE.join(" or ")}), not ${JSON.stringify(args)}; deploy through --record`);
  }
  const refused = preflight(root, target);
  if (refused.length) throw new Error(`REFUSED before the CLI started:\n- ${refused.join("\n- ")}`);
  const cli = verifyPinnedCli(join(cliPath, "..", "..", "..", ".."));
  if (cli !== realpathSync(cliPath)) throw new Error(`${cliPath} is not that install's vc.js`);
  return spawnIt(process.execPath, [cli, ...args], { cwd: join(root, "app"), env: { ...deployEnv(process.env), NEXT_TELEMETRY_DISABLED: "1" } });
}

/** The record is replaced whole (written beside it, then renamed), so a crash never leaves it half-written. */
function writeRecordAtomically(file: string, rec: ReleaseRecord): void {
  const tmp = `${file}.writing`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, file);
}

export async function deployRecorded(d: {
  root: string; recordFile: string; prod: boolean; run: Run; git: Git; appDir?: string; env?: NodeJS.ProcessEnv;
  /** The pinned CLI's vc.js, as installPinnedCli returned it; checked again here. */
  cli?: string;
  /** The reviewed target; the release (main) never passes it, so it is read from the committed ops/release-target.json. */
  target?: ReleaseTarget;
}): Promise<DeployResult> {
  const fail = (reason: string): DeployResult => ({ ok: false, reason });
  const retarget = RETARGETING_ENV.filter((k) => (d.env ?? process.env)[k]);
  if (retarget.length) return fail(`${retarget.join(", ")} set in the environment would deploy to another project than the recorded one; unset it`);
  const app = d.appDir ?? join(d.root, "app");
  const outDir = join(app, ".vercel", "output");
  if (!existsSync(d.recordFile)) return fail(`no release record at ${d.recordFile}; run ops/release-robinhood.sh`);
  const rec = JSON.parse(readFileSync(d.recordFile, "utf8")) as ReleaseRecord;
  if (rec.deploymentUrl) return fail(`this record was already deployed to ${rec.deploymentUrl}; build a new release`);
  if (rec.deployStartedAt) return fail(`a deploy of this record started at ${rec.deployStartedAt} and did not finish; check Vercel, then build a new release`);
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
  // the link must still be the reviewed target right before the deploy (this entry point can be run on its own)
  const extra = [
    ...releaseTargetRefusals(d.root, app, d.target), ...repoRootRefusals(d.root, app), ...cliExtraUploads(app), ...uploadSet(outDir, app).failures,
  ];
  if (extra.length) return fail(`the deploy would upload files the scan never covered; nothing was deployed:\n${extra.join("\n")}`);
  const before = artifactDigest(outDir, app);
  const drift = differences(recorded, before.lines);
  if (before.sha256 !== rec.artifactSha256 || drift.length) {
    return fail(`the artifact changed after it was scanned; nothing was deployed. Release again.\n${drift.slice(0, 20).join("\n")}`);
  }

  let cli: string;
  try {
    if (!d.cli) throw new Error("no --cli given");
    cli = verifyPinnedCli(join(d.cli, "..", "..", "..", ".."));
    if (cli !== realpathSync(d.cli)) throw new Error(`${d.cli} is not that install's vc.js`);
  } catch (e) {
    return fail(`the deploy runs only the verified pinned CLI (ops/release-deploy.ts --install-cli): ${e instanceof Error ? e.message : e}`);
  }
  // written before Vercel is contacted, so an interrupted deploy still leaves a record that says one may have happened
  const started: ReleaseRecord = { ...rec, deployStartedAt: new Date().toISOString(), target: d.prod ? "production" : "preview" };
  writeRecordAtomically(d.recordFile, started);
  const r = await d.run(process.execPath, [cli, "deploy", "--prebuilt", ...(d.prod ? ["--prod"] : [])], app);
  const urls = [...new Set(r.stdout.split("\n").map((l) => l.trim()).filter((l) => URL_LINE.test(l)))];
  if (r.code !== 0 || urls.length !== 1) {
    const why = urls.length > 1 ? `, several deployment URLs printed (${urls.join(", ")})` : urls.length ? "" : ", no deployment URL printed";
    return fail(`vercel deploy failed (exit ${r.code}${why}); the record says a deploy started and has no URL: check Vercel`);
  }
  const url = urls[0]!;

  // the check after the upload; if it cannot even run (the folder vanished, a read failed), the deploy is void too
  let problems: string[];
  try {
    const after = artifactDigest(outDir, app);
    const lateExtra = [...repoRootRefusals(d.root, app), ...cliExtraUploads(app), ...uploadSet(outDir, app).failures];
    problems = after.sha256 !== rec.artifactSha256 || lateExtra.length ? [...lateExtra, ...differences(recorded, after.lines)] : [];
    if (after.sha256 !== rec.artifactSha256 && !problems.length) problems = ["the upload set's digest changed"];
  } catch (e) {
    problems = [`the check after the upload could not run: ${e instanceof Error ? e.message : e}`];
  }
  if (problems.length) {
    const undo = d.prod
      ? `it is already live in production: roll back now (node ${cli} rollback) and release again`
      : `do not use or share it; remove it (node ${cli} remove ${url}) and release again`;
    // the URL and what to do reach the operator even if the record cannot be written
    let unrecorded = "";
    try {
      writeRecordAtomically(d.recordFile, { ...started, voidedDeploymentUrl: url });
    } catch (e) {
      unrecorded = ` (the record could not be updated: ${e instanceof Error ? e.message : e}; note this URL yourself)`;
    }
    return fail(
      `files changed while they were uploading, so ${url} may not be the scanned artifact; ${undo}${unrecorded}.\n` +
        problems.slice(0, 20).join("\n"),
    );
  }
  const done: ReleaseRecord = { ...started, deploymentUrl: url, deployedAt: new Date().toISOString() };
  writeRecordAtomically(d.recordFile, done);
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
  if (process.argv.includes("--preflight")) {
    const f = preflight(ROOT);
    if (f.length) {
      console.error(`release-deploy REFUSED before the build:\n- ${f.join("\n- ")}`);
      process.exit(1);
    }
    return;
  }
  const rc = process.argv.indexOf("--run-cli");
  if (rc > 0) {
    const sep = process.argv.indexOf("--");
    const cw = process.argv.indexOf("--cwd");
    if (sep < 0 || cw < 0 || !process.argv[rc + 1] || !process.argv[cw + 1]) throw new Error("--run-cli <vc.js> --cwd app -- <args>");
    if (resolve(ROOT, process.argv[cw + 1]!) !== join(ROOT, "app")) throw new Error(`REFUSED: --cwd must be this checkout's app folder, not ${process.argv[cw + 1]}`);
    process.exit(execPinnedCli(resolve(process.argv[rc + 1]!), process.argv.slice(sep + 1), ROOT));
  }
  const ic = process.argv.indexOf("--install-cli");
  if (ic > 0) {
    const dir = process.argv[ic + 1];
    if (!dir) throw new Error("--install-cli needs an empty folder");
    console.log(installPinnedCli(resolve(dir)));
    return;
  }
  const ci = process.argv.indexOf("--cli");
  const at = process.argv.indexOf("--record");
  const file = at > 0 ? process.argv[at + 1] : undefined;
  if (!file) throw new Error("--record needs the release record, e.g. release/robinhood-prebuilt.json");
  const cliPath = ci > 0 ? process.argv[ci + 1] : undefined;
  const r = await deployRecorded({
    root: ROOT, recordFile: resolve(ROOT, file), prod: process.argv.includes("--prod"), run, git: git(ROOT), cli: cliPath && resolve(cliPath),
  });
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
