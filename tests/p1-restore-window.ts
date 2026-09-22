/**
 * P1 regression test, from the adversary pass: the restore in
 * tests/p1-harness-proof.ts must cover the whole window in which the harness
 * binary exists. It did not, and this is the test that proved it.
 *
 * p1-harness-proof.ts states its own invariant at the `finally`:
 *   "Leave target/deploy holding the deployable program, not the harness one,
 *    or tests/deploy-artifact.spec.ts is red for whoever runs the suite next."
 *
 * But `anchor build -- --features harness` runs at module top level, outside
 * the `try`. Everything between that build and the `try` can throw: the marker
 * check, the IDL read and parse, the read_clock IDL assertion, the instruction
 * encode, and both fixture assertions. On any of those paths the process exits
 * with target/deploy/othello.so carrying the harness probe and no restore runs.
 *
 * This drives the most reachable of those paths: the fixture at
 * tests/fixtures/NFLXx.json is temporarily the repo's own AAPLx fixture, which
 * is what the hardcoded NFLX_MINT constant exists to catch ("hardcoded so the
 * fixture cannot quietly become a different mint"). The proof correctly
 * refuses. The defect is what it leaves behind.
 *
 * Both fixtures are the repo's real ones, fetched by ops/fetch-fixtures.ts from
 * mainnet on 2026-09-21; nothing here is fabricated. The fixture file is put
 * back before any assertion, and a default `anchor build` runs at the end so
 * the worktree is left as it was found.
 *
 * Run: pnpm tsx tests/p1-restore-window.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    anchorBuild,
    carriesHarnessMarker,
    HARNESS_BUILD_MARKER,
    PROGRAM_SO,
    REPO,
    TOOLCHAIN_PATH,
} from "./artifacts.ts";

const NFLX_FIXTURE = resolve(REPO, "tests/fixtures/NFLXx.json");
const AAPL_FIXTURE = resolve(REPO, "tests/fixtures/AAPLx.json");
const PROOF = resolve(REPO, "tests/p1-harness-proof.ts");

const env = { ...process.env, PATH: TOOLCHAIN_PATH };

// Start from the state the suite expects: the deployable, default build.
// anchorBuild asserts its own exit status; the local copy this replaced
// returned it and then discarded it.
anchorBuild();
assert.equal(carriesHarnessMarker(), false, "precondition: target/deploy/othello.so starts as the default build");

const savedFixture = readFileSync(NFLX_FIXTURE);
let proofStatus: number | null = null;

try {
  // The exact drift the proof's hardcoded NFLX_MINT constant guards against.
  copyFileSync(AAPL_FIXTURE, NFLX_FIXTURE);

  proofStatus = spawnSync(process.execPath, ["--import", "tsx", PROOF], {
    cwd: REPO,
    env,
    encoding: "utf8",
  }).status;
} finally {
  writeFileSync(NFLX_FIXTURE, savedFixture);
}

assert.deepEqual(
  readFileSync(NFLX_FIXTURE),
  savedFixture,
  "tests/fixtures/NFLXx.json was not restored byte for byte; restore it with `git checkout tests/fixtures/NFLXx.json`",
);
assert.notEqual(proofStatus, 0, "the proof should refuse a fixture that is not the SPEC 9b.1 NFLXx mint");

try {
  assert.equal(
    carriesHarnessMarker(),
    false,
    `p1-harness-proof.ts exited ${proofStatus} leaving target/deploy/othello.so carrying ${HARNESS_BUILD_MARKER}: ` +
      "the harness build is created outside the try/finally, so the restore never runs and pnpm test is red",
  );
  console.log("OK: a failed P1 run leaves the default build in target/deploy");
} finally {
  // Leave the worktree as it was found, whatever the assertion said.
  anchorBuild();
}
