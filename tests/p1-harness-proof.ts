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
 * Harness: bankrun (`solana-bankrun`), not LiteSVM. Both were tried.
 *
 * bankrun ran this workload in every attempt. The npm `litesvm` bindings abort
 * the process with `std::bad_alloc` shortly after the first transaction that
 * invokes the loaded program: 0 of 8 runs survived, and the abort lands on
 * whatever allocates next (observed in Keypair.generate, setAccount and
 * sendTransaction), so it has no single stable call site. Ten consecutive
 * builtin system-transfer transactions in one instance are unaffected.
 *
 * That abort is NOT a categorical property of LiteSVM, and an earlier version of
 * this comment wrongly said it was. The adversary pass ran the same workload in
 * a separate git worktree on 0.5.0, 0.7.0 and 0.8.0 and it completed. Running
 * one identical probe against both installs settled it: the worktree's litesvm
 * survived 5/5 and this tree's aborted 5/5, with byte-identical
 * litesvm-linux-x64-gnu@0.8.0 native binaries (md5 bacf18e6cd02bf371b93a8ed4ceb03f7).
 * So it is install-tree dependent and the cause is not established.
 *
 * The recorded reason for choosing bankrun is therefore reliability observed
 * here, not a proven LiteSVM defect. Reported for OPEN-QUESTIONS.md line 1;
 * this script does not write the ADR.
 *
 * Run: pnpm tsx tests/p1-harness-proof.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import {
    anchorBuild,
    carriesHarnessMarker,
    DEPLOY_DIR,
    HARNESS_BUILD_MARKER,
    PROGRAM_IDL,
    PROGRAM_NAME,
    PROGRAM_SO,
    REPO,
    TOOLCHAIN_PATH,
} from "./artifacts.ts";

/** SPEC 9b.1, hardcoded so the fixture cannot quietly become a different mint. */
const NFLX_MINT = "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** One second before NFLXx's multiplier changes, and the second itself. */
const BOUNDARY_SECONDS = [1_763_337_299, 1_763_337_300] as const;

// bankrun reads the program from BPF_OUT_DIR, and target/deploy is already that
// layout. Both are read inside start(), so setting them here is early enough.
process.env.BPF_OUT_DIR = resolve(REPO, DEPLOY_DIR);
process.env.RUST_LOG = process.env.RUST_LOG ?? "off";

// Dynamic, so RUST_LOG is set before the native logger initialises on load.
const { start, Clock } = await import("solana-bankrun");

type Fixture = { address: string; owner: string; dataLen: number; dataBase64: string };

/**
 * Builds the harness artifact and refuses to go on unless it really is one.
 * Otherwise a default build, which has no read_clock at all, could fail in a way
 * that reads as a harness limitation rather than as the wrong binary.
 */
function buildHarnessProgram(): { programId: anchor.web3.PublicKey; data: Buffer } {
  anchorBuild("--", "--features", "harness");

  assert.ok(
    carriesHarnessMarker(),
    `${PROGRAM_SO} is not a harness build: it does not carry ${HARNESS_BUILD_MARKER}`,
  );

  const idl = JSON.parse(readFileSync(resolve(REPO, PROGRAM_IDL), "utf8")) as anchor.Idl & { address: string };
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

/**
 * Restores the deployable build. Every path that can run once the harness binary
 * exists has to reach this, including a signal: an abandoned run that leaves the
 * harness .so behind turns `pnpm test` red two steps away from what failed.
 */
function restoreDefaultBuild(): void {
  anchorBuild();
  console.log(`    (restored the default build in ${PROGRAM_SO})`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    restoreDefaultBuild();
    process.exit(130);
  });
}

console.log("P1 harness proof: bankrun loads the real NFLXx mint and warps the Clock to an exact second\n");

try {
  // Inside the try, not above it: from here on a throw must still restore.
  const { programId, data } = buildHarnessProgram();
  const fixture = readFixture();

  console.log(`  harness built ${PROGRAM_SO} carries ${HARNESS_BUILD_MARKER}`);
  console.log(`  program id    ${programId.toBase58()}`);

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
  restoreDefaultBuild();
}
