/**
 * T25 adversary: ops/export-member-key.ts on a machine where the demo member
 * keypairs are not present (a fresh HOME: another laptop, a new WSL distro).
 *
 * Requirement under test (T25 brief): export-member-key prints ONE member's
 * secret key for Phantom import and must never write that secret anywhere;
 * the key it prints must be the circle's member for that seat, or it must
 * refuse (ops/play-round.ts refuses the same mismatch: "The member keys in
 * ~/.config/othello-demo/devnet/ are not the members recorded in
 * ops/demo-circle.json").
 *
 * HOME is a fresh temp directory, so no real keypair is read. stdout is a
 * pseudo-terminal from util-linux `script`, so the script's TTY guard passes
 * exactly as it does in the owner's own terminal. The secret the script
 * prints is a throwaway it generated inside the temp HOME; it is never shown.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REPO } from "./artifacts.ts";
import { toFixed1e9 } from "../app/src/lib/scaledUi.ts";

const demo = JSON.parse(readFileSync(resolve(REPO, "ops/demo-circle.json"), "utf8")) as { members: string[] };

describe("T25 adversary: export-member-key without the member keypairs", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "othello-t25-adv-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("never writes a secret and never prints a key that is not the circle's seat-2 member", () => {
    const tsx = resolve(REPO, "node_modules/.bin/tsx");
    const run = spawnSync("script", ["-qec", `${tsx} ops/export-member-key.ts --seat 2`, "/dev/null"], {
      cwd: REPO,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    const printed = /Seat 2 address \(public\): (\w+)/.exec(run.stdout)?.[1] ?? null;
    const keyDir = join(home, ".config/othello-demo/devnet");
    const written = existsSync(keyDir) ? readdirSync(keyDir) : [];

    assert.ok(
      printed === null || printed === demo.members[1],
      `exit ${run.status}: printed a private key for ${printed}, which is not seat 2 of the demo circle ` +
        `(${demo.members[1]}); secret key files it wrote to disk: ${written.join(", ")}`,
    );
    // A key it prints must be one that already existed, never one it just made and saved.
    assert.ok(printed === null || written.length === 0, `printed a key it generated and wrote to disk: ${written.join(", ")}`);
  });
});

/**
 * app/src/lib/scaledUi.ts toFixed1e9 against the program's own decode.
 * Requirement: SPEC.md I5 and the T18 brief, the app "must show the program's
 * integer, and refuse what the program refuses". The vector is the program's
 * own unit test, programs/othello/src/valuation.rs:917
 * decode_accepts_the_largest_multiplier_that_still_fits: 2^34 decodes to
 * 17_179_869_184_000_000_000 (and 2^35 is refused). That integer is exactly
 * representable as a double (2^43 x 1953125), so a number or a bigint result
 * both compare exactly here.
 */
describe("T18 adversary: toFixed1e9 at the top of the program's range", () => {
  it("accepts 2^34 as the program does, at the program's integer", () => {
    let got: unknown;
    assert.doesNotThrow(() => {
      got = toFixed1e9(2 ** 34);
    }, "the program accepts 2^34 (valuation.rs:917); the app must not refuse it");
    assert.equal(BigInt(got as number | bigint), 17_179_869_184_000_000_000n);
    assert.throws(() => toFixed1e9(2 ** 35), /cannot be a live multiplier/, "2^35 is refused by both");
  });
});
