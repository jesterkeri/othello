/**
 * The build artifacts the guards assert against, how to produce them, and the
 * one spelling of each path.
 *
 * Both guards are only as good as the freshness of what they read: `pnpm test`
 * does not build, so a stale `target/` would green either of them. Every reader
 * here checks the artifact is at least as new as the sources that produce it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Idl } from "@coral-xyz/anchor";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PROGRAM_NAME = "othello";
export const PROGRAM_SRC = "programs/othello/src";
export const DEPLOY_DIR = "target/deploy";
export const PROGRAM_SO = `${DEPLOY_DIR}/${PROGRAM_NAME}.so`;
export const PROGRAM_IDL = `target/idl/${PROGRAM_NAME}.json`;

/**
 * Logged by `read_clock` under the `harness` cargo feature. Declared once in
 * programs/othello/src/lib.rs; tests/deploy-artifact.spec.ts asserts this copy
 * still matches it, because a guard that greps for a literal the program no
 * longer contains passes by finding nothing.
 */
export const HARNESS_BUILD_MARKER = "OTHELLO-HARNESS-BUILD-DO-NOT-DEPLOY";

/** The shell these run from does not necessarily source the user profile. */
export const TOOLCHAIN_PATH = [
  resolve(homedir(), ".cargo/bin"),
  resolve(homedir(), ".local/share/solana/install/active_release/bin"),
  process.env.PATH ?? "",
].join(":");

export type BuiltIdl = Idl & { address: string };

export function read(relativePath: string): string {
  return readFileSync(resolve(REPO, relativePath), "utf8");
}

/** Runs `anchor build`, and refuses to continue if it did not succeed. */
export function anchorBuild(...extraArgs: string[]): void {
  const result = spawnSync("anchor", ["build", ...extraArgs], {
    cwd: REPO,
    env: { ...process.env, PATH: TOOLCHAIN_PATH },
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `anchor build ${extraArgs.join(" ")} failed: ${result.stderr || result.stdout || result.error}`,
  );
}

export function carriesHarnessMarker(): boolean {
  return readFileSync(resolve(REPO, PROGRAM_SO)).includes(HARNESS_BUILD_MARKER, 0, "latin1");
}

/**
 * The sources whose bytes the artifact literally embeds. Enumerated rather than
 * listed, because a hand-written list silently stops covering each new file: it
 * named only lib.rs until valuation.rs and errors.rs arrived, which left both
 * guards able to pass on bytes that predate the decoder.
 *
 * Deliberately only `.rs`. The manifests are build inputs too, and the adversary
 * pass on 118ba66 was right that omitting them leaves a hole, but they cannot be
 * guarded by mtime: cargo skips relinking when content has not changed, so a
 * manifest whose mtime moved without its content moving leaves the artifact
 * permanently "stale" and no rebuild can clear it. An unclearable guard is worse
 * than none. What the manifests are actually load-bearing FOR is asserted on
 * their content instead, in tests/workspace.spec.ts, which needs no build at all.
 */
function programSources(): string[] {
  const sources = readdirSync(resolve(REPO, PROGRAM_SRC), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => join(entry.parentPath, entry.name));

  assert.ok(sources.length > 0, `no .rs files under ${PROGRAM_SRC}; the freshness guard is blind`);

  return sources;
}

/**
 * Refuses to assert anything about an artifact older than the sources it claims
 * to describe. Without this, deleting `target/` or editing a source and
 * skipping the build leaves both guards passing on yesterday's bytes.
 */
function assertFresh(artifact: string): void {
  const built = statSync(resolve(REPO, artifact)).mtimeMs;

  for (const source of programSources()) {
    assert.ok(
      built >= statSync(source).mtimeMs,
      `${artifact} is older than ${source.replace(`${REPO}/`, "")}. Run \`anchor build\` before testing; this guard is meaningless on a stale artifact.`,
    );
  }
}

export function builtIdl(): BuiltIdl {
  assertFresh(PROGRAM_IDL);
  return JSON.parse(read(PROGRAM_IDL)) as BuiltIdl;
}

/** The deployable program, read as bytes-as-latin1 so markers can be matched. */
export function deployedProgram(): string {
  assertFresh(PROGRAM_SO);
  return readFileSync(resolve(REPO, PROGRAM_SO), "latin1");
}
