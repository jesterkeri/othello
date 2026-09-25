/**
 * S2 adversary: squatting the devnet stand-in addresses.
 *
 * Both addresses are derived with createWithSeed from the admin's PUBLIC key
 * and are published in ops/devnet-mints.json and devnet.rs before either mint
 * exists. createWithSeed stops a stranger from CREATING an account there, but
 * not from FUNDING one: a plain System transfer to the address leaves a
 * system-owned account with lamports, and SystemProgram.createAccountWithSeed
 * refuses any address that already holds lamports ("already in use"). The
 * devnet build pins these two addresses, so the admin must still be able to
 * make the mints there with the instructions ops/create-devnet-mints.ts sends.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import { harness, type Harness } from "./harness.ts";
import {
  NFLXX_MIRROR_SEED,
  NFLXX_MIRROR_SPACE,
  TEST_USDC_SPACE,
  TOKEN_2022,
  createDevnetMintsIxs,
  devnetMintAddresses,
} from "../ops/devnet-mints.ts";

describe("S2 adversary: a stranger pre-funds a stand-in address", () => {
  let h: Harness;
  let admin: anchor.web3.Keypair;

  const send = async (ixs: anchor.web3.TransactionInstruction[], signers: anchor.web3.Keypair[]) => {
    const tx = new anchor.web3.Transaction();
    tx.recentBlockhash = h.context.lastBlockhash;
    tx.feePayer = signers[0]!.publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    await h.context.banksClient.processTransaction(tx);
  };

  const rentFor = async (space: number) => Number((await h.context.banksClient.getRent()).minimumBalance(BigInt(space)));

  beforeEach(async () => {
    h = await harness([]);
    admin = h.authority;
  });

  it("a stranger cannot CREATE an account at the mirror address (control: the base key must sign)", async () => {
    const stranger = h.fund();
    const { nflxxMirror } = await devnetMintAddresses(admin.publicKey);
    const ix = anchor.web3.SystemProgram.createAccountWithSeed({
      fromPubkey: stranger.publicKey,
      newAccountPubkey: nflxxMirror,
      basePubkey: admin.publicKey,
      seed: NFLXX_MIRROR_SEED,
      lamports: await rentFor(NFLXX_MIRROR_SPACE),
      space: NFLXX_MIRROR_SPACE,
      programId: TOKEN_2022,
    });
    // web3.js marks the base as a signer; strip that so the stranger alone can sign.
    ix.keys = ix.keys.map((k) => (k.pubkey.equals(admin.publicKey) ? { ...k, isSigner: false } : k));
    await assert.rejects(send([ix], [stranger]));
    assert.equal(await h.context.banksClient.getAccount(nflxxMirror), null);
  });

  it("the admin can still create both mints after a stranger sends rent-exempt lamports to their addresses", async () => {
    const stranger = h.fund();
    const { nflxxMirror, testUsdc } = await devnetMintAddresses(admin.publicKey);

    // The squat: about 0.0018 devnet SOL, no signature from the admin.
    const dust = await rentFor(0);
    await send(
      [
        anchor.web3.SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: nflxxMirror, lamports: dust }),
        anchor.web3.SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: testUsdc, lamports: dust }),
      ],
      [stranger],
    );
    const squatted = await h.context.banksClient.getAccount(nflxxMirror);
    assert.ok(squatted && squatted.owner.equals(anchor.web3.SystemProgram.programId), "precondition: the squat landed");

    await h.nextSlot();
    // Exactly what `ops/create-devnet-mints.ts --create` sends for the admin.
    await send(
      await createDevnetMintsIxs(admin.publicKey, {
        nflxxMirror: await rentFor(NFLXX_MIRROR_SPACE),
        testUsdc: await rentFor(TEST_USDC_SPACE),
      }),
      [admin],
    );

    const mirror = await h.context.banksClient.getAccount(nflxxMirror);
    assert.ok(mirror && mirror.owner.equals(TOKEN_2022), "the NFLXx mirror was never created at the address the devnet build pins");
    assert.equal(mirror.data.length, NFLXX_MIRROR_SPACE);
  });
});
