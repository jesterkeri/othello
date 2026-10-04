/**
 * Adversary test on 7552f17 (requirement 3: the CI path triggers must cover every file the release specs and the
 * release itself depend on).
 *
 * ops/release-robinhood.sh installs the ROOT dependencies of the fresh clone (`pnpm install --frozen-lockfile`, from the
 * root package.json and pnpm-lock.yaml) and runs every check with that install's tsx (node_modules/tsx/dist/cli.mjs);
 * ops/trust-config.ts parses the app's config with that install's typescript and checks addresses with its viem. tsx
 * reads the root tsconfig.json. The fresh clone's contracts libraries come from .gitmodules
 * (`git submodule update --init`). The adapter job in .github/workflows/evm.yml installs the same root lockfile before
 * it runs the release specs. Yet none of those files is in evm.yml's `paths:` triggers, so a change that only bumps the
 * root lockfile (a new tsx, typescript or viem under the release) runs none of the release specs.
 *
 *   npx mocha --import=tsx tests/release-ci-path-triggers-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

describe("CI: evm.yml's path triggers cover the release's own inputs (adversary on 7552f17)", () => {
  // read by the release at run time (ops/release-robinhood.sh lines 115, 118, 125) and by the adapter job's install
  const releaseInputs = ["package.json", "pnpm-lock.yaml", "tsconfig.json", ".gitmodules"];

  for (const event of ["pull_request", "push"] as const) {
    it(`${event}: a change to any root file the release installs, compiles or clones from runs the release specs`, () => {
      const globs = triggers(event).map(globToRegExp);
      // not vacuous: the matcher accepts what the list plainly covers
      for (const covered of ["ops/release-robinhood.sh", "tests/release-script-harness.ts", "tests/reviewed-settings.ts", "app/pnpm-lock.yaml", "ops/vercel-cli/package-lock.json"]) {
        assert.ok(globs.some((g) => g.test(covered)), `precondition: ${covered} is matched by the ${event} triggers`);
      }
      const missed = releaseInputs.filter((f) => !globs.some((g) => g.test(f)));
      assert.deepEqual(missed, [], `${event}: these release inputs trigger no release spec run: ${missed.join(", ")}`);
    });
  }
});
