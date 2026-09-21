/**
 * P1: harness proof.
 *
 * T03, T04 and T06 all rest on one capability nothing in this repo has shown
 * yet: a test harness that loads the REAL NFLXx mint at its REAL mainnet
 * address and places the Clock on an exact second, with the program seeing that
 * second. NFLXx's newMultiplierEffectiveTimestamp is 1763337300 (SPEC 9b.1), so
 * the boundary proved here is the boundary the valuation gate turns on.
 *
 * This proves the harness and nothing else. No multiplier is decoded and no
 * valuation is asserted; that is T03 and T06, where the decoder exists.
 *
 * Harness: bankrun (`solana-bankrun`), not LiteSVM. Both were tried. The npm
 * `litesvm` bindings abort the process with `std::bad_alloc` on the SECOND
 * invocation of a loaded SBF program, on every version of its web3.js line
 * (0.5.0, 0.7.0, 0.8.0); builtin-program transactions are unaffected, so the
 * fault is in invoking a loaded program more than once. A gate that runs one
 * transaction per harness would hide it; T06 runs many. The result is reported
 * for OPEN-QUESTIONS.md. This script does not write an ADR.
 *
 * Run: pnpm tsx tests/p1-harness-proof.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** SPEC 9b.1, hardcoded so the fixture cannot quietly become a different mint. */
const NFLX_MINT = "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** One second before NFLXx's multiplier changes, and the second itself. */
const BOUNDARY_SECONDS = [1_763_337_299, 1_763_337_300] as const;

/** programs/othello/src/lib.rs logs this from read_clock under `harness`. */
const HARNESS_BUILD_MARKER = "OTHELLO-HARNESS-BUILD-DO-NOT-DEPLOY";

const PROGRAM_NAME = "othello";
const DEPLOY_DIR = resolve(REPO, "target/deploy");
const PROGRAM_SO = resolve(DEPLOY_DIR, `${PROGRAM_NAME}.so`);
const PROGRAM_IDL = resolve(REPO, "target/idl", `${PROGRAM_NAME}.json`);

// The shell this runs from does not necessarily source the user profile.
const TOOLCHAIN_PATH = [
  resolve(homedir(), ".cargo/bin"),
  resolve(homedir(), ".local/share/solana/install/active_release/bin"),
  process.env.PATH ?? "",
].join(":");

// bankrun reads the program from BPF_OUT_DIR, and target/deploy is already that
// layout. Both are read inside start(), so setting them here is early enough.
process.env.BPF_OUT_DIR = DEPLOY_DIR;
process.env.RUST_LOG = process.env.RUST_LOG ?? "off";

// Dynamic, so RUST_LOG is set before the native logger initialises on load.
const { start, Clock } = await import("solana-bankrun");

type Fixture = { address: string; owner: string; dataLen: number; dataBase64: string };

function anchorBuild(...extraArgs: string[]): void {
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

/**
 * Builds the harness artifact and refuses to go on unless it really is one.
 * Otherwise a default build, which has no read_clock at all, could fail in a way
 * that reads as a harness limitation rather than as the wrong binary.
 */
function buildHarnessProgram(): { programId: anchor.web3.PublicKey; data: Buffer } {
  anchorBuild("--", "--features", "harness");

  assert.ok(
    readFileSync(PROGRAM_SO).includes(HARNESS_BUILD_MARKER, 0, "latin1"),
    `${PROGRAM_SO} is not a harness build: it does not carry ${HARNESS_BUILD_MARKER}`,
  );

  const idl = JSON.parse(readFileSync(PROGRAM_IDL, "utf8")) as anchor.Idl & { address: string };
  const names = idl.instructions.map((ix) => ix.name);
  assert.ok(names.includes("read_clock"), `harness IDL has no read_clock, only: ${names.join(", ") || "(none)"}`);

  return {
    programId: new anchor.web3.PublicKey(idl.address),
    data: new anchor.BorshInstructionCoder(idl).encode("read_clock", {}),
  };
}

function readFixture(): Fixture {
  const fixture = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/NFLXx.json"), "utf8")) as Fixture;

  assert.equal(fixture.address, NFLX_MINT, "fixture is not the SPEC 9b.1 NFLXx mint");
  assert.equal(fixture.owner, TOKEN_2022_PROGRAM, "fixture mint is not owned by Token-2022");

  return fixture;
}

const { programId, data } = buildHarnessProgram();
const fixture = readFixture();

console.log("P1 harness proof: bankrun loads the real NFLXx mint and warps the Clock to an exact second\n");
console.log(`  harness built ${PROGRAM_SO.replace(`${REPO}/`, "")} carries ${HARNESS_BUILD_MARKER}`);
console.log(`  program id    ${programId.toBase58()}`);

try {
  const context = await start([{ name: PROGRAM_NAME, programId }], []);
  const client = context.banksClient;

  // 1. The real mint, at its real address, byte for byte.
  const mint = new anchor.web3.PublicKey(fixture.address);
  const mintData = Buffer.from(fixture.dataBase64, "base64");
  assert.equal(mintData.length, fixture.dataLen, "fixture dataBase64 does not decode to dataLen bytes");

  const rent = await client.getRent();
  context.setAccount(mint, {
    lamports: Number(rent.minimumBalance(BigInt(mintData.length))),
    data: mintData,
    owner: new anchor.web3.PublicKey(fixture.owner),
    executable: false,
  });

  // Read it back out of the harness, not out of the variable just written.
  const loaded = await client.getAccount(mint);
  assert.ok(loaded, `${NFLX_MINT} is not in the harness after setAccount`);
  assert.equal(loaded.data.length, fixture.dataLen, "loaded account is a different length");
  assert.equal(Buffer.from(loaded.data).toString("base64"), fixture.dataBase64, "loaded bytes differ from the fixture");
  assert.equal(new anchor.web3.PublicKey(loaded.owner).toBase58(), TOKEN_2022_PROGRAM, "loaded owner is not Token-2022");
  console.log(`  mint loaded   ${NFLX_MINT}  ${fixture.dataLen} bytes, owner Token-2022, base64 identical to the fixture`);

  // 2. Each exact second, read back by the program itself.
  for (const second of BOUNDARY_SECONDS) {
    const current = await client.getClock();
    context.setClock(
      new Clock(current.slot, current.epochStartTimestamp, current.epoch, current.leaderScheduleEpoch, BigInt(second)),
    );
    assert.equal((await client.getClock()).unixTimestamp, BigInt(second), "setClock did not take");

    // A fresh payer per call: the instruction carries no arguments, so two calls
    // from one payer would be byte-identical and rejected as already processed.
    const payer = anchor.web3.Keypair.generate();
    context.setAccount(payer.publicKey, {
      lamports: anchor.web3.LAMPORTS_PER_SOL,
      data: Buffer.alloc(0),
      owner: anchor.web3.SystemProgram.programId,
      executable: false,
    });

    const tx = new anchor.web3.Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    tx.add(new anchor.web3.TransactionInstruction({ programId, keys: [], data }));
    tx.sign(payer);

    const meta = await client.processTransaction(tx);
    const returned = meta.returnData;
    assert.ok(returned, `read_clock returned no data at ${second}`);

    const bytes = Buffer.from(returned.data);
    assert.equal(bytes.length, 8, `expected an 8-byte i64, got ${bytes.length} bytes`);

    const seen = Number(bytes.readBigInt64LE(0));
    assert.equal(seen, second, `program read the clock back as ${seen}, expected ${second}`);
    console.log(`  clock         set to ${second}, program returned ${seen}`);
  }

  console.log("\nOK: bankrun loads the real NFLXx mint at its canonical address and places the Clock on");
  console.log("    1763337299 and 1763337300 exactly, with the T01 program reading each one back.");
  console.log("    No multiplier was decoded here; that is T03 and T06.");
} finally {
  // Leave target/deploy holding the deployable program, not the harness one, or
  // tests/deploy-artifact.spec.ts is red for whoever runs the suite next.
  anchorBuild();
  console.log(`    (restored the default build in ${PROGRAM_SO.replace(`${REPO}/`, "")})`);
}
