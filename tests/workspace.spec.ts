/**
 * T01 smoke test: the Anchor workspace is wired end to end.
 *
 * Proves the one program id is the same in lib.rs, Anchor.toml and the built
 * IDL, and that the TypeScript client can consume that IDL.
 *
 * The harness probe's real guard is tests/deploy-artifact.spec.ts, which reads
 * the deployable binary. The IDL check below is kept as the cheaper, earlier
 * signal, not as the control.
 *
 * Run: pnpm test   (or `anchor test`, which runs this via Anchor.toml [scripts])
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import { builtIdl, read } from "./artifacts.ts";

const BASE58 = "[1-9A-HJ-NP-Za-km-z]+";

describe("T01 Anchor workspace", () => {
  it("declares one program id in lib.rs, Anchor.toml and the built IDL", () => {
    const idl = builtIdl();
    const declared = new RegExp(`declare_id!\\("(${BASE58})"\\)`).exec(read("programs/othello/src/lib.rs"));
    const configured = new RegExp(`^othello\\s*=\\s*"(${BASE58})"`, "m").exec(read("Anchor.toml"));

    assert.equal(declared?.[1], idl.address, "declare_id! in programs/othello/src/lib.rs");
    assert.equal(configured?.[1], idl.address, "[programs.localnet] othello in Anchor.toml");
  });

  it("loads the built IDL into the TypeScript client", () => {
    const idl = builtIdl();
    const provider = new anchor.AnchorProvider(
      new anchor.web3.Connection("http://127.0.0.1:8899", "processed"),
      new anchor.Wallet(anchor.web3.Keypair.generate()),
      anchor.AnchorProvider.defaultOptions(),
    );

    const program = new anchor.Program(idl, provider);

    assert.equal(program.programId.toBase58(), idl.address);
  });

  /// What the manifests are load-bearing for, asserted on their content rather
  /// than through the artifact's mtime. These hold whether or not anything has
  /// been built, which is the point: the `harness` feature reaching `default`
  /// is the failure the deploy guard exists to catch, and this catches it at the
  /// source rather than only in bytes that may not have been rebuilt yet.
  it("keeps the manifests saying the things the program depends on", () => {
    const programManifest = read("programs/othello/Cargo.toml");
    const workspaceManifest = read("Cargo.toml");

    assert.match(programManifest, /^default = \[\]$/m, "programs/othello/Cargo.toml: default features must stay empty");
    assert.match(programManifest, /^harness = \[\]$/m, "programs/othello/Cargo.toml: the harness feature must exist and be opt-in");

    // Money code: a silent wrap is a wrong balance, not a warning.
    assert.match(workspaceManifest, /^overflow-checks = true$/m, "Cargo.toml: release builds must keep overflow checks on");
    // Keeps dev-dependency features out of the program build.
    assert.match(workspaceManifest, /^resolver = "2"$/m, "Cargo.toml: resolver 2 keeps dev-dependency features out of the program");

    assert.match(read("rust-toolchain.toml"), /^channel = "\d+\.\d+\.\d+"$/m, "rust-toolchain.toml must pin an exact compiler");
  });

  it("keeps the harness probe out of the default build's IDL", () => {
    const names = builtIdl().instructions.map((ix) => ix.name);

    assert.ok(!names.includes("read_clock"), `default build exposes ${names.join(", ")}`);
  });
});
