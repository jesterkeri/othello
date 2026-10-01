/**
 * Adversary test on 2dd59b2 (requirement 2: the CI path triggers must cover every file the release depends on, anything
 * a change to which could change what the release builds, checks or deploys, for both push and pull_request).
 *
 * The release builds app/ with `next build` inside a fresh clone of the commit (ops/release-robinhood.sh, the CLI's
 * `build` step). Next looks UPWARD from app/ for two build configs: its browser targets (getSupportedBrowsers, through
 * browserslist's loadConfig) and its PostCSS config (findConfig, through find-up). app/ has neither, so a file at the
 * repository root is the one Next takes: a commit that only adds a root `.browserslistrc` or `postcss.config.mjs`
 * changes what the release compiles and uploads. ops/trust-config.ts says so itself ("every file at the repository root
 * (Next looks upward for some build configs), is a build input", the comment above NOT_SOURCE). Neither name is in
 * evm.yml's `paths:` triggers, so such a commit runs no release spec.
 *
 * This spec asks Next's own functions (app/node_modules/next, the version the release builds with) what they read from
 * a clone of HEAD, before and after a root file is added, then checks the triggers.
 *
 *   npx mocha --import=tsx tests/release-ci-root-build-config-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const nextRequire = createRequire(join(ROOT, "app", "package.json"));
const { getSupportedBrowsers } = nextRequire("next/dist/build/utils.js") as { getSupportedBrowsers: (dir: string, dev: boolean) => string[] };
// browserslist caches each directory's config path: cleared after the root files are written, or the precondition's
// answer would be read back
const browserslist = nextRequire("next/dist/compiled/browserslist") as { clearCaches: () => void };
const { findConfigPath } = nextRequire("next/dist/lib/find-config.js") as { findConfigPath: (dir: string, key: string) => Promise<string | undefined> };

/** GitHub's path-filter glob, as far as evm.yml uses it: `**` any depth, `*` within one segment. */
function globToRegExp(glob: string): RegExp {
  const re = glob.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${re}$`);
}

function triggers(event: "pull_request" | "push"): string[] {
  const yml = readFileSync(join(ROOT, ".github", "workflows", "evm.yml"), "utf8");
  const block = yml.slice(yml.indexOf(`  ${event}:`));
  const line = block.split("\n").find((l) => l.trim().startsWith("paths:"));
  assert.ok(line, `precondition: evm.yml has a paths: trigger under ${event}`);
  return JSON.parse(line.trim().slice("paths:".length).trim()) as string[];
}

describe("CI: evm.yml's path triggers cover the root build configs Next reads for app/ (adversary on 2dd59b2)", () => {
  let tmp = "";
  let app = "";
  const rootFiles = { ".browserslistrc": "chrome 120\n", "postcss.config.mjs": "export default { plugins: {} };\n" };

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "release-ci-root-config-"));
    const repo = join(tmp, "repo");
    execFileSync("git", ["clone", "-q", "--no-local", ROOT, repo]);
    app = join(repo, "app");
    // preconditions: in HEAD's own layout neither config exists anywhere Next looks
    const defaults = getSupportedBrowsers(app, false);
    assert.ok(!defaults.includes("chrome 120"), `precondition: Next's default targets for app/ (${defaults.join(", ")})`);
    assert.equal(await findConfigPath(app, "postcss"), undefined, "precondition: no PostCSS config above the clone's app/");
    for (const [name, body] of Object.entries(rootFiles)) writeFileSync(join(repo, name), body);
    browserslist.clearCaches();
  });

  after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it("a root .browserslistrc and a root postcss.config.mjs are what next build reads for app/ (the build input is real)", async () => {
    assert.deepEqual(getSupportedBrowsers(app, false), ["chrome 120"]);
    assert.equal(await findConfigPath(app, "postcss"), join(app, "..", "postcss.config.mjs"));
  });

  for (const event of ["pull_request", "push"] as const) {
    it(`${event}: a commit that adds or changes either root config runs the release specs`, () => {
      const globs = triggers(event).map(globToRegExp);
      // not vacuous: the matcher accepts the root inputs this diff listed
      for (const covered of ["package.json", "pnpm-lock.yaml", "tsconfig.json", ".gitmodules"]) {
        assert.ok(globs.some((g) => g.test(covered)), `precondition: ${covered} is matched by the ${event} triggers`);
      }
      const missed = Object.keys(rootFiles).filter((f) => !globs.some((g) => g.test(f)));
      assert.deepEqual(missed, [], `${event}: these root build inputs of app/ trigger no release spec run: ${missed.join(", ")}`);
    });
  }
});
