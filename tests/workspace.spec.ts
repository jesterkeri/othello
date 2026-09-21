/**
 * T01 smoke test: the Anchor workspace is wired end to end.
 *
 * Proves the one program id is the same in lib.rs, Anchor.toml and the built
 * IDL, that the TypeScript client can consume that IDL, and that the harness
 * probe is absent from a default build.
 *
 * Run: pnpm test   (or `anchor test`, which runs this via Anchor.toml [scripts])
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE58 = "[1-9A-HJ-NP-Za-km-z]+";

type BuiltIdl = anchor.Idl & { address: string };

function read(relativePath: string): string {
  return readFileSync(resolve(REPO, relativePath), "utf8");
}

function builtIdl(): BuiltIdl {
  return JSON.parse(read("target/idl/othello.json")) as BuiltIdl;
}

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

  it("keeps the harness probe out of the default build", () => {
    // read_clock exists only under the `harness` cargo feature, for P1. A default
    // `anchor build` must never carry it, or a test-only instruction ships.
    const names = builtIdl().instructions.map((ix) => ix.name);

    assert.ok(!names.includes("read_clock"), `default build exposes ${names.join(", ")}`);
  });
});
