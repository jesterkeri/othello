/**
 * Shared accessors for the build artifacts the T01 guards assert against.
 *
 * Both guards are only as good as the freshness of what they read: `pnpm test`
 * does not build, so a stale `target/` would green either of them. Every reader
 * here checks the artifact is at least as new as the sources that produce it.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Idl } from "@coral-xyz/anchor";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything an `anchor build` consumes to produce the artifacts below. */
const PROGRAM_SOURCES = ["programs/othello/src/lib.rs", "programs/othello/Cargo.toml", "Cargo.lock"];

export type BuiltIdl = Idl & { address: string };

export function read(relativePath: string): string {
  return readFileSync(resolve(REPO, relativePath), "utf8");
}

function mtimeMs(relativePath: string): number {
  return statSync(resolve(REPO, relativePath)).mtimeMs;
}

/**
 * Refuses to assert anything about an artifact older than the source it claims
 * to describe. Without this, deleting `target/` or editing lib.rs and skipping
 * the build leaves both guards passing on yesterday's bytes.
 */
function assertFresh(artifact: string): void {
  const built = mtimeMs(artifact);

  for (const source of PROGRAM_SOURCES) {
    assert.ok(
      built >= mtimeMs(source),
      `${artifact} is older than ${source}. Run \`anchor build\` before testing; this guard is meaningless on a stale artifact.`,
    );
  }
}

export function builtIdl(): BuiltIdl {
  assertFresh("target/idl/othello.json");
  return JSON.parse(read("target/idl/othello.json")) as BuiltIdl;
}

/** The deployable program, read as bytes-as-latin1 so markers can be matched. */
export function deployedProgram(): string {
  assertFresh("target/deploy/othello.so");
  return readFileSync(resolve(REPO, "target/deploy/othello.so"), "latin1");
}
