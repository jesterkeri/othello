/**
 * S2: the DEVNET build itself, `--features devnet`, the binary T23 deploys.
 *
 * The default-build specs cannot see this: the feature swaps the allowlist and
 * adds init_pool's test-USDC pin, so a devnet build that still accepted the
 * mainnet xStocks, or any classic SPL "USDC", would pass every other spec.
 * This builds the devnet program into target/devnet/ and runs it in bankrun,
 * against real Token-2022 mint bytes at the devnet addresses.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { HARNESS_BUILD_MARKER, REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import {
  BEFORE_SPLIT,
  FIXTURE_MINTS,
  SPL_TOKEN_PROGRAM,
  fetchAccount,
  harness,
  initFeed,
  initPoolIx,
  poolAddress,
  splMintAccount,
  type Harness,
} from "./harness.ts";
import {
  NFLXX_MIRROR_SPACE,
  TEST_USDC_SPACE,
  createDevnetMintsIxs,
  devnetMintAddresses,
} from "../ops/devnet-mints.ts";

const DEVNET_SO = "target/devnet/othello.so";
const DEMO_DISCOUNT = 2000;

const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as {
  cluster: string;
  admin: string;
  nflxxMirror: string;
  testUsdc: string;
  labels: { nflxxMirror: string; testUsdc: string };
};
const NFLXX_MIRROR = new anchor.web3.PublicKey(record.nflxxMirror);
const TEST_USDC = new anchor.web3.PublicKey(record.testUsdc);

/** The top-level `pub const NAME: Pubkey = Pubkey::from_str_const("…")` values in devnet.rs. */
function devnetRs(): Record<string, string> {
  const src = readFileSync(resolve(REPO, "programs/othello/src/devnet.rs"), "utf8");
  return Object.fromEntries(
    [...src.matchAll(/^pub const ([A-Z_]+): Pubkey =\s*Pubkey::from_str_const\("([^"]+)"\)/gm)].map((m) => [m[1], m[2]]),
  );
}

describe("S2 the devnet build", () => {
  let h: Harness;

  before(function () {
    this.timeout(600_000);
    const built = spawnSync(
      "cargo",
      ["build-sbf", "--manifest-path", "programs/othello/Cargo.toml", "--features", "devnet", "--sbf-out-dir", "target/devnet"],
      { cwd: REPO, env: { ...process.env, PATH: TOOLCHAIN_PATH }, encoding: "utf8" },
    );
    assert.equal(built.status, 0, `devnet build failed: ${built.stderr || built.error}`);
  });

  /**
   * Real mint bytes at the devnet addresses: made by the same instructions the
   * create script sends, for a throwaway admin, then copied to the recorded
   * addresses (whose admin key this test does not hold).
   */
  const placeDevnetMints = async () => {
    const maker = h.fund(10 * anchor.web3.LAMPORTS_PER_SOL);
    const rent = await h.context.banksClient.getRent();
    const tx = new anchor.web3.Transaction().add(
      ...(await createDevnetMintsIxs(maker.publicKey, {
        nflxxMirror: Number(rent.minimumBalance(BigInt(NFLXX_MIRROR_SPACE))),
        testUsdc: Number(rent.minimumBalance(BigInt(TEST_USDC_SPACE))),
      })),
    );
    tx.recentBlockhash = h.context.lastBlockhash;
    tx.feePayer = maker.publicKey;
    tx.sign(maker);
    await h.context.banksClient.processTransaction(tx);

    const made = await devnetMintAddresses(maker.publicKey);
    for (const [from, to] of [
      [made.nflxxMirror, NFLXX_MIRROR],
      [made.testUsdc, TEST_USDC],
    ] as const) {
      const info = (await h.context.banksClient.getAccount(from))!;
      h.putAccount(to, Buffer.from(info.data), info.owner);
    }
  };

  beforeEach(async () => {
    h = await harness(["NFLXx"], DEVNET_SO);
    await h.setClock(BEFORE_SPLIT);
    await placeDevnetMints();
  });

  it("ops/devnet-mints.json, devnet.rs and the derivation from the admin all name the same addresses", async () => {
    const rs = devnetRs();
    assert.equal(record.cluster, "devnet");
    assert.equal(rs.ADMIN, record.admin);
    assert.equal(rs.NFLXX_MIRROR, record.nflxxMirror);
    assert.equal(rs.TEST_USDC, record.testUsdc);

    const derived = await devnetMintAddresses(new anchor.web3.PublicKey(record.admin));
    assert.equal(derived.nflxxMirror.toBase58(), record.nflxxMirror);
    assert.equal(derived.testUsdc.toBase58(), record.testUsdc);
  });

  // TASKS S2 "the label is asserted by a test", and Joshua 2026-09-25: test
  // USDC "must never be presented as real USDC". The frontend shows these.
  it("labels both stand-ins as what they are, never as the real asset", () => {
    assert.match(record.labels.nflxxMirror, /devnet mirror/);
    assert.match(record.labels.nflxxMirror, /not the real NFLXx/);
    assert.match(record.labels.testUsdc, /test USDC/);
    assert.match(record.labels.testUsdc, /not real USDC/);
  });

  it("carries no harness probe", () => {
    const so = readFileSync(resolve(REPO, DEVNET_SO), "latin1");
    assert.ok(!so.includes(HARNESS_BUILD_MARKER), "the devnet build is a harness build");
  });

  it("accepts the NFLXx mirror as collateral and refuses the real NFLXx", async () => {
    await initFeed(h, NFLXX_MIRROR);
    assert.equal(await h.refusal(initFeed(h, new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx))), "MintNotAllowed");
  });

  it("opens a pool only for test USDC with the mirror", async () => {
    await initPoolIx(h, { usdcMint: TEST_USDC, stockMint: NFLXX_MIRROR, discountBps: DEMO_DISCOUNT }).rpc();
    const pool = await fetchAccount<{ discountBps: number }>(h.program, "liquidationPool", poolAddress(h.program, TEST_USDC, NFLXX_MIRROR)[0]);
    assert.equal(pool.discountBps, DEMO_DISCOUNT);
  });

  it("refuses any other classic SPL USDC, so no circle can use one", async () => {
    const otherUsdc = anchor.web3.Keypair.generate().publicKey;
    const m = splMintAccount(6);
    h.putAccount(otherUsdc, m.data, new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM));

    assert.equal(
      await h.refusal(initPoolIx(h, { usdcMint: otherUsdc, stockMint: NFLXX_MIRROR, discountBps: DEMO_DISCOUNT }).rpc()),
      "MintNotAllowed",
    );
  });

  it("refuses test USDC paired with a real xStock", async () => {
    assert.equal(
      await h.refusal(
        initPoolIx(h, { usdcMint: TEST_USDC, stockMint: new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx), discountBps: DEMO_DISCOUNT }).rpc(),
      ),
      "MintNotAllowed",
    );
  });
});
