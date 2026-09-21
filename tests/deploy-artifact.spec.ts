/**
 * The guard that matters at deploy time: the bytes in target/deploy/othello.so.
 *
 * Found by the adversary pass on T01. tests/workspace.spec.ts reads
 * target/idl/othello.json, but `anchor deploy` and `solana program deploy`
 * upload the .so, and the two are written by different steps.
 * `cargo build-sbf --features harness` rewrites the .so and leaves the IDL
 * untouched, so the IDL check passed while the artifact that ships carried the
 * harness probe. lib.rs claimed read_clock "can never reach a deployed build";
 * nothing enforced it. This asserts it on the artifact itself.
 *
 * Run: pnpm test   (or `anchor test`, which runs this via Anchor.toml [scripts])
 */
import assert from "node:assert/strict";

import { deployedProgram } from "./artifacts.ts";

const HARNESS_MARKERS = [
  // Deliberate: programs/othello/src/lib.rs logs this from read_clock.
  "OTHELLO-HARNESS-BUILD-DO-NOT-DEPLOY",
  // Incidental, and kept because two independent markers are harder to lose
  // than one. Anchor emits the first unless `no-log-ix-name` is set.
  "Instruction: ReadClock",
  "clock.unix_timestamp=",
];

describe("T01 deploy artifact", () => {
  it("keeps the harness probe out of the deployable program binary", () => {
    const program = deployedProgram();

    const found = HARNESS_MARKERS.filter((marker) => program.includes(marker));

    assert.deepEqual(found, [], `target/deploy/othello.so carries the harness probe: ${found.join(", ")}`);
  });
});
