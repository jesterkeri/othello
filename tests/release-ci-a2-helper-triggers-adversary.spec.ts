/**
 * Adversary test on 56565df (A2 chain switch replayed onto the release; requirement: nothing the A2 wallet specs need
 * may drop out of CI).
 *
 * evm.yml now runs the six tests/a2-*.spec.ts wallet specs (one process each). Every one of them imports
 * tests/artifacts.ts for REPO, the root they resolve app/src from (`import { REPO } from "./artifacts.ts"`). The
 * workflow lists the helpers its other specs import (tests/reviewed-settings.ts, tests/fake-pinned-cli.ts,
 * tests/release-script-harness.ts) in its `paths:` triggers, but not tests/artifacts.ts, and no other workflow runs
 * these specs. So a commit that changes only tests/artifacts.ts (REPO, or a new top-level import) runs none of the A2
 * wallet specs, and a break in all six lands green.
 *
 * The check: every local module that an A2 spec named in evm.yml's run lines imports, directly or through another
 * local module, is matched by the pull_request and the push `paths:` triggers.
 *
 *   npx mocha --import=tsx tests/release-ci-a2-helper-triggers-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const YML = readFileSync(join(ROOT, ".github", "workflows", "evm.yml"), "utf8");

/** GitHub's path-filter glob, as far as evm.yml uses it: `**` any depth, `*` within one segment. */
function globToRegExp(glob: string): RegExp {
  const re = glob.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${re}$`);
}

function triggers(event: "pull_request" | "push"): string[] {
  const block = YML.slice(YML.indexOf(`  ${event}:`));
  const line = block.split("\n").find((l) => l.trim().startsWith("paths:"));
  assert.ok(line, `precondition: evm.yml has a paths: trigger under ${event}`);
  return JSON.parse(line.trim().slice("paths:".length).trim()) as string[];
}

/** The specs evm.yml runs: every tests/<name>.spec.ts named on a run line. */
const ciSpecs = [...new Set([...YML.matchAll(/tests\/[A-Za-z0-9_.-]+\.spec\.ts/g)].map((m) => m[0]))];
/**
 * The specs this change added to evm.yml (the A2 wallet specs, the chain switch, EVM discovery and session). Scoped to
 * them: tests/config-fixture.ts, imported by four release and trust-config specs, is untriggered on the base branch
 * (b936b29) too, so it is not this change's defect.
 */
const a2Specs = ciSpecs.filter((f) => /^tests\/(a2-|evm-|chain-switch)/.test(f));

/** Local modules a file imports (relative specifiers only), as repo-relative paths, followed transitively. */
function localImports(start: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length) {
    const rel = queue.shift()!;
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = relative(ROOT, resolve(dirname(abs), m[1]!));
      if (target.startsWith("app/") || target.startsWith("ops/") || target.startsWith("evm/") || target.startsWith("core/")) continue;
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return seen;
}

describe("CI: evm.yml's path triggers cover the helpers its specs import (adversary on 56565df)", () => {
  it("precondition: the A2 wallet specs are run by evm.yml and import tests/artifacts.ts", () => {
    for (const f of ["a2-cancelled-pick-adversary", "a2-cancelled-solana-rearmed-adversary", "a2-closed-solana-reopened-adversary",
      "a2-modal-render-adversary", "a2-modal-search-adversary", "a2-wallet-answers-adversary"]) {
      assert.ok(ciSpecs.includes(`tests/${f}.spec.ts`), `precondition: evm.yml runs tests/${f}.spec.ts`);
      assert.ok(localImports([`tests/${f}.spec.ts`]).has("tests/artifacts.ts"), `precondition: tests/${f}.spec.ts imports tests/artifacts.ts`);
    }
  });

  for (const event of ["pull_request", "push"] as const) {
    it(`${event}: a change to any local module an A2 spec imports runs that spec`, () => {
      const globs = triggers(event).map(globToRegExp);
      // not vacuous: the matcher accepts the helpers the list plainly covers
      for (const covered of ["tests/release-script-harness.ts", "tests/reviewed-settings.ts", "tests/fake-pinned-cli.ts", "tests/a2-modal-render-adversary.spec.ts"]) {
        assert.ok(globs.some((g) => g.test(covered)), `precondition: ${covered} is matched by the ${event} triggers`);
      }
      assert.equal(a2Specs.length, 9, "precondition: evm.yml runs the six A2 wallet specs, chain-switch and the two EVM specs");
      const missed = [...localImports(a2Specs)].filter((f) => !globs.some((g) => g.test(f))).sort();
      assert.deepEqual(missed, [], `${event}: these modules imported by the A2 specs evm.yml runs trigger no run: ${missed.join(", ")}`);
    });
  }
});
