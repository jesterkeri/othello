/**
 * S2: the hand-built instructions in ops/devnet-mints.ts, run against the REAL
 * Token-2022 (tests/fixtures/spl_token_2022.so, dumped from devnet) and SPL
 * Token programs in bankrun. The devnet script sends exactly these bytes, so
 * this is the proof that they are right before any SOL is spent.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import { harness, tokenAmount, type Harness } from "./harness.ts";
import {
  NFLXX_MIRROR_DECIMALS,
  NFLXX_MIRROR_SEED,
  NFLXX_MIRROR_SPACE,
  SPL_TOKEN,
  TEST_USDC_DECIMALS,
  TEST_USDC_SEED,
  TEST_USDC_SPACE,
  TOKEN_2022,
  ataAddress,
  createAtaIdempotentIx,
  createDevnetMintsIxs,
  devnetMintAddresses,
  mintToCheckedIx,
  updateMultiplierIx,
} from "../ops/devnet-mints.ts";

/** Token-2022 mint layout: base 82, padding to 165, account type at 165, TLV from 166. */
const TLV = 166;

describe("S2 devnet stand-in mints", () => {
  let h: Harness;
  let admin: anchor.web3.Keypair;

  const sendAll = async (ixs: anchor.web3.TransactionInstruction[], signer = admin) => {
    const tx = new anchor.web3.Transaction();
    tx.recentBlockhash = h.context.lastBlockhash;
    tx.feePayer = signer.publicKey;
    tx.add(...ixs);
    tx.sign(signer);
    await h.context.banksClient.processTransaction(tx);
  };

  const rentFor = async (space: number) => Number((await h.context.banksClient.getRent()).minimumBalance(BigInt(space)));

  beforeEach(async () => {
    h = await harness([]);
    admin = h.authority;
  });

  it("derives both addresses from the admin's public key alone, and only from it", async () => {
    const a = await devnetMintAddresses(admin.publicKey);
    const again = await devnetMintAddresses(admin.publicKey);
    const other = await devnetMintAddresses(anchor.web3.Keypair.generate().publicKey);

    assert.ok(a.nflxxMirror.equals(again.nflxxMirror) && a.testUsdc.equals(again.testUsdc), "deterministic");
    assert.ok(!a.nflxxMirror.equals(other.nflxxMirror), "another admin gets other addresses");
    assert.ok(
      a.nflxxMirror.equals(await anchor.web3.PublicKey.createWithSeed(admin.publicKey, NFLXX_MIRROR_SEED, TOKEN_2022)),
    );
    assert.ok(a.testUsdc.equals(await anchor.web3.PublicKey.createWithSeed(admin.publicKey, TEST_USDC_SEED, SPL_TOKEN)));
  });

  it("creates the NFLXx mirror as a Token-2022 mint whose ScaledUiAmountConfig reads multiplier 1.0", async () => {
    const { nflxxMirror } = await devnetMintAddresses(admin.publicKey);
    await sendAll(
      await createDevnetMintsIxs(admin.publicKey, {
        nflxxMirror: await rentFor(NFLXX_MIRROR_SPACE),
        testUsdc: await rentFor(TEST_USDC_SPACE),
      }),
    );

    const info = await h.context.banksClient.getAccount(nflxxMirror);
    assert.ok(info, "the mint exists");
    const data = Buffer.from(info.data);
    assert.ok(info.owner.equals(TOKEN_2022));
    assert.equal(data.length, NFLXX_MIRROR_SPACE);
    assert.equal(data.readUInt32LE(0), 1, "mint authority is Some");
    assert.ok(new anchor.web3.PublicKey(data.subarray(4, 36)).equals(admin.publicKey), "the admin can mint");
    assert.equal(data[44], NFLXX_MIRROR_DECIMALS);
    assert.equal(data[45], 1, "initialized");
    assert.equal(data.readUInt32LE(46), 0, "no freeze authority");
    assert.equal(data[165], 1, "account type: Mint");
    assert.equal(data.readUInt16LE(TLV), 25, "extension 25, ScaledUiAmountConfig");
    assert.equal(data.readUInt16LE(TLV + 2), 56);
    assert.ok(new anchor.web3.PublicKey(data.subarray(TLV + 4, TLV + 36)).equals(admin.publicKey), "the admin can change the multiplier");
    assert.equal(data.readDoubleLE(TLV + 36), 1.0, "multiplier 1.0");
  });

  it("creates the test USDC as a CLASSIC SPL mint (so init_pool's guard accepts it), and mints to an ATA", async () => {
    const { testUsdc } = await devnetMintAddresses(admin.publicKey);
    await sendAll(
      await createDevnetMintsIxs(admin.publicKey, {
        nflxxMirror: await rentFor(NFLXX_MIRROR_SPACE),
        testUsdc: await rentFor(TEST_USDC_SPACE),
      }),
    );

    const info = await h.context.banksClient.getAccount(testUsdc);
    assert.ok(info);
    assert.ok(info.owner.equals(SPL_TOKEN), "classic SPL Token, never Token-2022");
    assert.equal(info.data.length, TEST_USDC_SPACE);
    assert.equal(Buffer.from(info.data)[44], TEST_USDC_DECIMALS);

    await h.nextSlot();
    await sendAll([
      createAtaIdempotentIx(admin.publicKey, admin.publicKey, testUsdc, SPL_TOKEN),
      mintToCheckedIx(testUsdc, ataAddress(testUsdc, admin.publicKey, SPL_TOKEN), admin.publicKey, 1_000_000_000n, TEST_USDC_DECIMALS, SPL_TOKEN),
    ]);
    const ata = await h.context.banksClient.getAccount(ataAddress(testUsdc, admin.publicKey, SPL_TOKEN));
    assert.ok(ata);
    assert.equal(tokenAmount(Buffer.from(ata.data)), 1_000_000_000n, "1,000 test USDC");
  });

  it("schedules the split: UpdateMultiplier writes the new multiplier and its effective time", async () => {
    const { nflxxMirror } = await devnetMintAddresses(admin.publicKey);
    await sendAll(
      await createDevnetMintsIxs(admin.publicKey, {
        nflxxMirror: await rentFor(NFLXX_MIRROR_SPACE),
        testUsdc: await rentFor(TEST_USDC_SPACE),
      }),
    );

    const clock = await h.context.banksClient.getClock();
    const at = clock.unixTimestamp + 600n;
    await h.nextSlot();
    await sendAll([updateMultiplierIx(nflxxMirror, admin.publicKey, 10.0, at)]);

    const data = Buffer.from((await h.context.banksClient.getAccount(nflxxMirror))!.data);
    assert.equal(data.readDoubleLE(TLV + 36), 1.0, "the current multiplier is unchanged until the effective time");
    assert.equal(data.readBigInt64LE(TLV + 44), at, "effective time");
    assert.equal(data.readDoubleLE(TLV + 52), 10.0, "new multiplier 10");
  });

  it("refuses UpdateMultiplier from anyone but the admin", async () => {
    const { nflxxMirror } = await devnetMintAddresses(admin.publicKey);
    await sendAll(
      await createDevnetMintsIxs(admin.publicKey, {
        nflxxMirror: await rentFor(NFLXX_MIRROR_SPACE),
        testUsdc: await rentFor(TEST_USDC_SPACE),
      }),
    );
    const stranger = h.fund();
    const clock = await h.context.banksClient.getClock();
    await assert.rejects(
      sendAll([updateMultiplierIx(nflxxMirror, stranger.publicKey, 10.0, clock.unixTimestamp + 600n)], stranger),
      "a stranger cannot schedule a split",
    );
  });
});
