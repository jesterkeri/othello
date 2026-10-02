/**
 * Deploys the recorded prebuilt Robinhood artifact, and nothing else (Codex code review r3 M1: the record must bind
 * what Vercel receives, not only what was scanned earlier). ops/release-robinhood.sh runs it straight after
 * trust-config writes the record; Joshua runs that script with his own Vercel login.
 *
 *   npx tsx ops/release-deploy.ts --install-cli <empty dir>        prints the path of the verified pinned CLI
 *   npx tsx ops/release-deploy.ts --preflight [--before-pull]      the reviewed target, settings, repo root and app/.vercel
 *   npx tsx ops/release-deploy.ts --drop-pulled-env                 after pull: the pulled variables checked by name, then removed
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
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERCEL_CLI, VERCEL_CLI_INTEGRITY, artifactDigest, cliExtraUploads, gitIn, gitProgramDrivers, uncommittedPaths, uploadSet, type ReleaseRecord } from "./trust-config.ts";

export type Run = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
/**
 * The project's Environment Variables as Vercel holds them at this moment (Codex code review r6 F2), or why they could
 * not be read: their NAMES, for the reviewed-names check, and a fingerprint of every record (source, id, name, targets,
 * last change time; never a value), so the check after the deploy sees any change at all, a changed value or a new
 * record of a reviewed name included (adversary pass on 275f514).
 */
export type ProjectEnv = () => Promise<{ names: string[]; fingerprint: string } | { refusal: string }>;
type EnvRecord = {
  id?: unknown; key?: unknown; target?: unknown; updatedAt?: unknown; createdAt?: unknown; projectId?: unknown;
  type?: unknown; gitBranch?: unknown; customEnvironmentIds?: unknown; comment?: unknown; configurationId?: unknown;
};
/**
 * Asks Vercel through the verified pinned CLI (`vercel api`, the operator's own login), with a runner that never echoes
 * the answer, for both lists that reach the project's functions: the project's own variables
 * (`/v10/projects/<id>/env`) and the team's shared variables linked to it (`/v1/env`, records whose projectId names
 * the project). Any failure, an unreadable answer, more than one page, a record without a string name, or a project
 * list that does not report hiddenProductionEnvCount as 0 (variables hidden from this login, or not said: incomplete) is a
 * refusal: the deploy fails closed. Only each record's metadata is kept, never its value.
 */
export function projectEnvFromCli(quiet: Run, cli: string, app: string, ids: { orgId: string; projectId: string }): ProjectEnv {
  const ask = async (path: string): Promise<{ j: Record<string, unknown> } | { refusal: string }> => {
    let r: { code: number; stdout: string };
    try {
      r = await quiet(process.execPath, [cli, "api", path, "--raw"], app);
    } catch (e) {
      return { refusal: `the project's variables could not be read from Vercel (${e instanceof Error ? e.message : e})` };
    }
    if (r.code !== 0) return { refusal: `the project's variables could not be read from Vercel (exit ${r.code})` };
    try {
      const j: unknown = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      if (typeof j !== "object" || j === null) throw new Error("not an object");
      return { j: j as Record<string, unknown> };
    } catch {
      return { refusal: "Vercel's answer about the project's variables is not readable" };
    }
  };
  return async () => {
    const team = encodeURIComponent(ids.orgId);
    const own = await ask(`/v10/projects/${encodeURIComponent(ids.projectId)}/env?teamId=${team}`);
    if ("refusal" in own) return own;
    const shared = await ask(`/v1/env?teamId=${team}`);
    if ("refusal" in shared) return shared;
    if (!Array.isArray(own.j.envs)) return { refusal: "Vercel's answer names no project variables list" };
    if (!Array.isArray(shared.j.data)) return { refusal: "Vercel's answer names no shared variables list" };
    // the count must be reported and be 0: an answer that leaves it out does not say the list is complete (adversary
    // pass on 7afd45e)
    const hidden = own.j.hiddenProductionEnvCount;
    if (hidden !== 0) return { refusal: "Vercel does not report every project variable to this login (hiddenProductionEnvCount is not 0); the list is incomplete" };
    for (const j of [own.j, shared.j]) {
      const next = (j.pagination as { next?: unknown } | null | undefined)?.next;
      if (next !== undefined && next !== null) return { refusal: "the project's variables span more than one page" };
    }
    const records: { source: string; e: EnvRecord }[] = [
      ...(own.j.envs as EnvRecord[]).map((e) => ({ source: "project", e })),
      ...(shared.j.data as EnvRecord[])
        .filter((e) => Array.isArray(e?.projectId) && (e.projectId as unknown[]).includes(ids.projectId))
        .map((e) => ({ source: "shared", e })),
    ];
    const names: string[] = [];
    const prints: string[] = [];
    for (const { source, e } of records) {
      const key = e?.key;
      if (typeof key !== "string" || key === "") return { refusal: "a project variable in Vercel's answer has no name" };
      names.push(key);
      const targets = Array.isArray(e.target) ? [...(e.target as unknown[])].map(String).sort().join(",") : String(e.target ?? "");
      // every metadata field that decides where the variable applies or what it is, never the value (a change to any of
      // them during the deploy voids it even if Vercel did not move updatedAt; adversary pass on 7afd45e)
      const meta = JSON.stringify([e.type ?? null, e.gitBranch ?? null, e.customEnvironmentIds ?? null, e.comment ?? null, e.configurationId ?? null]);
      prints.push([source, String(e.id ?? ""), key, targets, String(e.updatedAt ?? ""), String(e.createdAt ?? ""), meta].join("\t"));
    }
    return { names: [...new Set(names)].sort(), fingerprint: prints.sort().join("\n") };
  };
}
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
  // the CLI runs git itself (the deploy's `git status` and `git log` for its metadata): with no system or global
  // configuration, so a program named by HOME's git config (core.fsmonitor) never runs (Codex r5 F2)
  const out: NodeJS.ProcessEnv = {
    VERCEL_TELEMETRY_DISABLED: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
  };
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
 * The target is read from HEAD of the checkout whose top is `root`, and the working-tree copy must be that same text:
 * an uncommitted edit is not reviewed (adversary pass on 222e3fc).
 */
export type ReleaseTarget = { vercelOrgId?: unknown; vercelProjectId?: unknown; vercelSettings?: unknown; vercelEnvNames?: unknown };

/**
 * The Vercel project's build settings are executable input, so they are reviewed like the target (Codex r5 F1).
 * `vercel pull` writes them into app/.vercel/project.json, and the pinned CLI's `build` (59.11.7) runs
 * `settings.installCommand` before compiling and hands buildCommand, outputDirectory, framework and nodeVersion to the
 * builder, in a folder that by then holds the pulled env files. ops/release-target.json therefore carries the one
 * accepted settings document (`vercelSettings`), and this accepts only a document that runs nothing of its own: no build,
 * dev or output override, no root directory, the install step skipped (`""`: the dependencies are only the release's own
 * frozen, --ignore-scripts install), directory listing off; only the Node.js version is the project's choice. After the
 * pull, the link's settings must be exactly that document before the build starts, and again before the scan's
 * preflight and the deploy. The keys are the ones the pinned CLI's pull writes (writeProjectSettings); any other
 * (monorepoManager, which the build also reads) is refused. `createdAt` is the project's creation date (the builder
 * reads it only to pick a package-manager default) and `analyticsId` appears only when Web Analytics is on, which
 * would put its id into the build: refused.
 */
export const VERCEL_SETTINGS_KEYS = [
  "framework", "devCommand", "installCommand", "buildCommand", "outputDirectory", "rootDirectory", "directoryListing", "nodeVersion",
] as const;
type VercelSettings = Record<(typeof VERCEL_SETTINGS_KEYS)[number], unknown>;
const FIXED_SETTINGS: Partial<VercelSettings> = {
  framework: "nextjs", devCommand: null, installCommand: "", buildCommand: null, outputDirectory: null, rootDirectory: null, directoryListing: false,
};
function reviewedSettings(s: unknown): { settings: VercelSettings } | { refusals: string[] } {
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    return { refusals: ["ops/release-target.json must name vercelSettings, the reviewed Vercel build settings"] };
  }
  const o = s as Record<string, unknown>;
  const f: string[] = [];
  for (const k of Object.keys(o)) {
    if (!(VERCEL_SETTINGS_KEYS as readonly string[]).includes(k)) f.push(`ops/release-target.json vercelSettings.${k} is not a build setting the release accepts`);
  }
  for (const [k, v] of Object.entries(FIXED_SETTINGS)) {
    if (!Object.hasOwn(o, k) || o[k] !== v) f.push(`ops/release-target.json vercelSettings.${k} must be ${JSON.stringify(v)}, not ${JSON.stringify(o[k])}`);
  }
  if (typeof o.nodeVersion !== "string" || !/^[0-9]{2}\.x$/.test(o.nodeVersion)) {
    f.push(`ops/release-target.json vercelSettings.nodeVersion must be a Vercel Node.js version like "22.x", not ${JSON.stringify(o.nodeVersion)}`);
  }
  return f.length ? { refusals: f } : { settings: o as VercelSettings };
}
function pulledSettingsRefusals(link: Record<string, unknown>, want: VercelSettings): string[] {
  const s = link.settings;
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    return [".vercel/project.json holds no build settings: the release's pull writes them, and the build would fetch its own"];
  }
  const o = s as Record<string, unknown>;
  const fix = "set the project's Build and Deployment settings in Vercel to ops/release-target.json's vercelSettings, then release again";
  const f: string[] = [];
  for (const k of Object.keys(o)) {
    if (k === "createdAt") {
      if (typeof o[k] !== "number") f.push(`.vercel/project.json settings.createdAt is ${JSON.stringify(o[k])}, not a date`);
    } else if (k === "analyticsId") {
      f.push(".vercel/project.json settings.analyticsId: Web Analytics is on for the project and the build would carry its id; turn it off");
    } else if (!(VERCEL_SETTINGS_KEYS as readonly string[]).includes(k)) {
      f.push(`.vercel/project.json settings.${k} is not a reviewed build setting`);
    }
  }
  for (const k of VERCEL_SETTINGS_KEYS) {
    // a key the pull left out is unset, which the CLI reads exactly as null; anything else must be present and equal
    const got = Object.hasOwn(o, k) ? o[k] : want[k] === null ? null : undefined;
    if (got !== want[k]) f.push(`.vercel/project.json settings.${k} is ${JSON.stringify(got)}, not the reviewed ${JSON.stringify(want[k])}: ${fix}`);
  }
  return f;
}

/**
 * The project's Environment Variables come down with the pull too (adversary pass on ce04cd9): the pinned CLI writes
 * every record to app/.vercel/.env.<target>.local and its build loads that file into the environment of pnpm, next and
 * every worker, so a project variable NODE_OPTIONS ran a program inside the sealed build with every pulled value in
 * reach, and the project would hand the same variable to the deployed functions. So the variables are checked by NAME
 * (their values are never read into anything, printed or kept) and then removed before the build: the build loads no
 * project variable (none is needed: the app reads its server variables at request time, Secret-type values are not even
 * downloaded, and a NEXT_PUBLIC_ value would be inlined into the bundle), and the build runner refuses while such a
 * file exists. A name must be one the reviewed target lists (`vercelEnvNames`, the app's own server variables) or one
 * Vercel writes itself (VERCEL, VERCEL_*, TURBO_*, NX_DAEMON); anything else, NODE_OPTIONS first, stops the release.
 */
const SYSTEM_ENV = /^(VERCEL|VERCEL_[A-Z0-9_]+|TURBO_[A-Z0-9_]+|NX_DAEMON)$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
function reviewedEnvNames(v: unknown): { names: Set<string> } | { refusals: string[] } {
  if (!Array.isArray(v)) return { refusals: ["ops/release-target.json must name vercelEnvNames, the project variables the app reads"] };
  const f: string[] = [];
  for (const n of v) {
    if (typeof n !== "string" || !ENV_NAME.test(n)) f.push(`ops/release-target.json vercelEnvNames: ${JSON.stringify(n)} is not a variable name`);
    else if (/^(NODE_|NEXT_PUBLIC_|NPM_CONFIG_)/.test(n) || SYSTEM_ENV.test(n)) {
      f.push(`ops/release-target.json vercelEnvNames: ${n} is not accepted (it changes node, is inlined into the bundle, configures npm, or is Vercel's own)`);
    }
  }
  return f.length ? { refusals: f } : { names: new Set(v as string[]) };
}
const PULLED_ENV = /^\.env\.[a-z]+\.local$/;
function pulledEnvFiles(app: string): string[] {
  const d = join(app, ".vercel");
  return existsSync(d) ? readdirSync(d).filter((n) => PULLED_ENV.test(n)).map((n) => join(d, n)) : [];
}
/** The variable names in a pulled env file (`NAME="value"` per line, as the pinned CLI writes it); values are skipped. */
function pulledEnvNames(file: string): { names: string[] } | { refusal: string } {
  const names: string[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "" || l.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l);
    if (!m) return { refusal: `${relative(dirname(dirname(file)), file)} line ${i + 1} is not NAME=value as the CLI writes it` };
    names.push(m[1]!);
  }
  return { names };
}
/**
 * After the pull (the release's step between pull and build): the full pulled-stage check of the target and settings,
 * then each pulled variable name against the reviewed list, then the files are removed. Returns the refusals; on any,
 * nothing is removed and the release stops.
 */
export function dropPulledEnv(root: string, target?: ReleaseTarget): string[] {
  const app = join(root, "app");
  const t = resolveTarget(root, target);
  if ("refusal" in t) return [t.refusal];
  const refused = releaseTargetRefusals(root, app, t.target, "pulled");
  const allowed = reviewedEnvNames(t.target.vercelEnvNames);
  if ("refusals" in allowed) return [...refused, ...allowed.refusals];
  const files = pulledEnvFiles(app);
  for (const file of files) {
    const r = pulledEnvNames(file);
    if ("refusal" in r) { refused.push(r.refusal); continue; }
    const unknown = r.names.filter((n) => !allowed.names.has(n) && !SYSTEM_ENV.test(n));
    if (unknown.length) {
      refused.push(`${relative(app, file)} holds project variables the release does not accept: ${unknown.join(", ")} (the project would also hand them to ` +
        "the deployed functions; remove them in Vercel, or review them into ops/release-target.json vercelEnvNames)");
    }
  }
  if (refused.length) return refused;
  for (const file of files) rmSync(file);
  return [];
}
/**
 * The build writes the functions' runtime from app/package.json's engines, which outranks the project's Node.js setting
 * (a range like ">=22" means the newest major Vercel has): the app must pin the reviewed version itself, or the deployed
 * runtime moves with Vercel's releases (adversary pass on ce04cd9). Checked before the build, which fixes it in the output.
 */
function enginesRefusals(root: string, app: string, target?: ReleaseTarget): string[] {
  const t = resolveTarget(root, target);
  if ("refusal" in t) return []; // releaseTargetRefusals reports it
  const reviewed = reviewedSettings(t.target.vercelSettings);
  if ("refusals" in reviewed) return [];
  let engines: unknown;
  try { engines = (JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { engines?: { node?: unknown } }).engines?.node; } catch { /* below */ }
  return engines === reviewed.settings.nodeVersion ? []
    : [`app/package.json engines.node is ${JSON.stringify(engines)}, not the reviewed ${JSON.stringify(reviewed.settings.nodeVersion)}: the deployment would run another Node.js`];
}
function pulledEnvPresent(app: string): string[] {
  return pulledEnvFiles(app).map((f) => `${relative(app, f)}: the build would load the project's variables; the release checks them by name ` +
    "and removes them first (ops/release-deploy.ts --drop-pulled-env)");
}

/**
 * Before the pull, the link may hold no settings, or a previous pull's (the pull replaces them): only the reviewed
 * document itself is checked then. From the pull on, the link's settings must be that document.
 */
export type ReleaseStage = "before-pull" | "pulled";
function committedTarget(root: string): { text: string } | { refusal: string } {
  const g = (a: string[]) => gitIn(root, a); // no caller GIT_* variables, no replace refs, no discovery above root
  let top: string;
  let text: string;
  try {
    top = g(["rev-parse", "--show-toplevel"]).trim();
    text = g(["cat-file", "blob", "HEAD:ops/release-target.json"]);
  } catch {
    return { refusal: "ops/release-target.json is not committed at HEAD of this checkout: the release has no reviewed target" };
  }
  if (realpathSync(top) !== realpathSync(root)) return { refusal: `${root} is not the top of its git checkout: the release has no reviewed target` };
  let disk: string | undefined;
  try { disk = readFileSync(join(root, "ops", "release-target.json"), "utf8"); } catch { /* differs below */ }
  if (disk !== text) return { refusal: "ops/release-target.json differs from the committed copy at HEAD: only the committed (reviewed) target is used" };
  return { text };
}
function resolveTarget(root: string, given?: ReleaseTarget): { target: ReleaseTarget } | { refusal: string } {
  if (given) return { target: given };
  const c = committedTarget(root);
  if ("refusal" in c) return { refusal: c.refusal };
  try {
    return { target: JSON.parse(c.text) };
  } catch {
    return { refusal: "ops/release-target.json is not valid JSON: the release has no reviewed target" };
  }
}
export function releaseTargetRefusals(root: string, app: string, given?: ReleaseTarget, stage: ReleaseStage = "pulled"): string[] {
  const t = resolveTarget(root, given);
  if ("refusal" in t) return [t.refusal];
  const target = t.target;
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
  const reviewed = reviewedSettings(target.vercelSettings);
  if ("refusals" in reviewed) found.push(...reviewed.refusals);
  else if (stage === "pulled") found.push(...pulledSettingsRefusals(link as Record<string, unknown>, reviewed.settings));
  const envNames = reviewedEnvNames(target.vercelEnvNames);
  if ("refusals" in envNames) found.push(...envNames.refusals);
  return found;
}

/**
 * The refusals that must hold before the release pulls or builds anything, and again before it scans: the reviewed
 * target, above the clone, its root, app/.vercel and the link.
 */
export function preflight(root: string, target?: ReleaseTarget, stage: ReleaseStage = "pulled"): string[] {
  const app = join(root, "app");
  const drivers = gitProgramDrivers(root);
  return [
    ...(drivers.length ? [`the repository's git config names programs git would run (${drivers.join(", ")}); remove them`] : []),
    ...releaseTargetRefusals(root, app, target, stage), ...enginesRefusals(root, app, target), ...ancestorRefusals(root),
    ...repoRootRefusals(root, app), ...cliExtraUploads(app), ...(stage === "pulled" ? pulledEnvPresent(app) : []),
  ];
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
  // the pull writes the settings; the build runs them, so it starts only once they are the reviewed ones (Codex r5 F1)
  const refused = preflight(root, target, args[0] === "pull" ? "before-pull" : "pulled");
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
  /**
   * How the project's variable names are read before and after the deploy. The release (main) never passes it: the
   * deploy then asks Vercel through the verified pinned CLI with a runner that echoes nothing. Specs pass their own.
   */
  projectEnv?: ProjectEnv;
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
  // the file list is always the record's sibling (writeRecord): a record naming any other path would let that path
  // change unchecked, e.g. an unreviewed page (adversary pass on 975dc76)
  const expectedList = norm(relative(d.root, d.recordFile.replace(/\.json$/, ".files.txt")));
  if (!d.recordFile.endsWith(".json") || norm(rec.fileList) !== expectedList) {
    return fail(`the record's file list must be ${expectedList}, beside the record, not ${rec.fileList}`);
  }
  const allowed = new Set([norm(relative(d.root, d.recordFile)), expectedList]);
  // git's paths are compared as git gives them: normalising them could turn a file named `release\robinhood-prebuilt.json`
  // into the record's own path (adversary pass on 5ed06d3); only the release's own two paths are normalised
  const other = d.git.changed().filter((p) => !allowed.has(p));
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
  // the project's variables reach the deployed functions at deployment time, so the names Vercel holds right now must be
  // reviewed ones (Codex r6 F2); a NODE_OPTIONS added after the pull would otherwise run in production
  const t = resolveTarget(d.root, d.target);
  if ("refusal" in t) return fail(t.refusal);
  const reviewedNames = reviewedEnvNames(t.target.vercelEnvNames);
  if ("refusals" in reviewedNames) return fail(reviewedNames.refusals.join("; "));
  const projectEnv = d.projectEnv ?? projectEnvFromCli(quietRun, cli, app, { orgId: String(t.target.vercelOrgId), projectId: String(t.target.vercelProjectId) });
  const envBefore = await projectEnv();
  if ("refusal" in envBefore) return fail(`${envBefore.refusal}; nothing was deployed`);
  const unreviewed = envBefore.names.filter((n) => !reviewedNames.names.has(n));
  if (unreviewed.length) {
    return fail(`the project holds variables the release does not accept: ${unreviewed.join(", ")} (they would reach the deployed functions); ` +
      "remove them in Vercel, or review them into ops/release-target.json vercelEnvNames; nothing was deployed");
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
  // and the project's variables must still be the ones checked before the deploy: a change while it ran may have reached
  // the deployment (Codex r6 F2)
  const envAfter = await projectEnv();
  if ("refusal" in envAfter) problems.push(`the project's variables could not be read again after the deploy: ${envAfter.refusal}`);
  else if (envAfter.fingerprint !== envBefore.fingerprint) {
    problems.push(`the project's variables changed during the deploy (a record added, removed or edited): before ${envBefore.names.join(", ") || "(none)"}, ` +
      `after ${envAfter.names.join(", ") || "(none)"}`);
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
      `files or the project's variables changed while the deploy ran, so ${url} may not be the scanned artifact with the reviewed ` +
        `variables; ${undo}${unrecorded}.\n` +
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

/** Like run, but nothing the command prints is echoed: Vercel's answer about the project's variables stays in the process. */
const quietRun: Run = (cmd, args, cwd) =>
  new Promise((done, reject) => {
    const p = spawn(cmd, args, { cwd, env: deployEnv(process.env), stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    p.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    p.on("error", reject);
    p.on("close", (code) => done({ code: code ?? 1, stdout }));
  });

/** The deploy's view of the checkout, through gitIn (no caller GIT_* variables, no replace refs, nothing above root). */
export const gitFor = (root: string): Git => ({
  head: () => gitIn(root, ["rev-parse", "HEAD"]).trim(),
  // git's status and the content check of the build's inputs against HEAD (sourceDrift): no ignore rule, stat cache
  // or setting can call a changed input clean
  changed: () => uncommittedPaths(root),
});

async function main() {
  if (process.argv.includes("--preflight")) {
    const f = preflight(ROOT, undefined, process.argv.includes("--before-pull") ? "before-pull" : "pulled");
    if (f.length) {
      console.error(`release-deploy REFUSED before the build:\n- ${f.join("\n- ")}`);
      process.exit(1);
    }
    return;
  }
  if (process.argv.includes("--drop-pulled-env")) {
    const f = dropPulledEnv(ROOT);
    if (f.length) {
      console.error(`release-deploy REFUSED after the pull:\n- ${f.join("\n- ")}`);
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
    root: ROOT, recordFile: resolve(ROOT, file), prod: process.argv.includes("--prod"), run, git: gitFor(ROOT), cli: cliPath && resolve(cliPath),
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
