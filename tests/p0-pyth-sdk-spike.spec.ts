// P0.3 spike (branch spike/P0-pyth-sdk only): pyth-solana-receiver-sdk 2.0.0 inside this program,
// run in bankrun against a REAL devnet PriceUpdateV2 (tests/fixtures/pyth-aaplx-devnet.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";

import { BN, call, harness, send, type Harness } from "./harness";

const fx = JSON.parse(readFileSync("tests/fixtures/pyth-aaplx-devnet.json", "utf8")) as {
  address: string; owner: string; feedId: string; dataBase64: string;
};
const data = Buffer.from(fx.dataBase64, "base64");
const RECEIVER = new anchor.web3.PublicKey(fx.owner);
const FEED = [...Buffer.from(fx.feedId, "hex")];
// PriceUpdateV2 (Full): 8 disc + 32 write_authority + 1 tag, then feed_id(32) price(8) conf(8) expo(4) publish(8)
const PRICE = data.readBigInt64LE(8 + 32 + 1 + 32);
// Refusal codes, from source: pyth-solana-receiver-sdk-2.0.0/src/error.rs (GetPriceError, PriceTooOld =
// 10000, then +1 each; Anchor adds 6000 to #[error_code]) and anchor-lang-error-1.1.2/src/lib.rs:251 (3007).
const PRICE_TOO_OLD = /custom program error 16000\b/;
const MISMATCHED_FEED_ID = /custom program error 16002\b/;
const INSUFFICIENT_VERIFICATION = /custom program error 16003\b/;
const OWNED_BY_WRONG_PROGRAM = /custom program error 3007\b/;
// anchor-lang-error-1.1.2/src/lib.rs:233-239: AccountDiscriminatorMismatch = 3002, AccountDidNotDeserialize = 3003.
const DISCRIMINATOR_MISMATCH = /custom program error 3002\b/;
const DID_NOT_DESERIALIZE = /custom program error 3003\b/;
const PUBLISH = Number(data.readBigInt64LE(8 + 32 + 1 + 32 + 8 + 8 + 4));

async function spike(h: Harness, at: anchor.web3.PublicKey, feed = FEED, maxAge = 60) {
  const ix = await call(h.program, "pythSpike", [feed, new BN(maxAge)]).accounts({ priceUpdate: at }).instruction();
  return send(h, ix);
}

describe("P0.3 Pyth SDK spike: real devnet AAPLx PriceUpdateV2", () => {
  let h: Harness;
  before(async () => {
    h = await harness([]);
    await h.setClock(PUBLISH + 10);
  });

  it("reads the price at its real address, fresh", async () => {
    const at = new anchor.web3.PublicKey(fx.address);
    h.putAccount(at, data, RECEIVER);
    const meta = await spike(h, at);
    assert.equal(Buffer.from(meta.returnData!.data).readBigInt64LE(0), PRICE);
  });

  it("accepts the same bytes at ANY address (no canonical PDA)", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    h.putAccount(at, data, RECEIVER);
    await h.nextSlot();
    const meta = await spike(h, at);
    assert.equal(Buffer.from(meta.returnData!.data).readBigInt64LE(0), PRICE);
  });

  it("refuses a price older than max_age", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    h.putAccount(at, data, RECEIVER);
    await h.setClock(PUBLISH + 61);
    assert.match(await h.refusal(spike(h, at)), PRICE_TOO_OLD);
    await h.setClock(PUBLISH + 10);
  });

  it("refuses the wrong feed id", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    h.putAccount(at, data, RECEIVER);
    await h.nextSlot();
    const wrong = [...FEED];
    wrong[0] ^= 1;
    assert.match(await h.refusal(spike(h, at, wrong)), MISMATCHED_FEED_ID);
  });

  it("refuses the same bytes owned by another program", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    h.putAccount(at, data, anchor.web3.SystemProgram.programId);
    await h.nextSlot();
    assert.match(await h.refusal(spike(h, at)), OWNED_BY_WRONG_PROGRAM);
  });

  it("refuses a Partial verification level", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    // Re-encode as Partial{num_signatures: 5}: tag 0x00 then one byte, the rest shifted by one.
    const partial = Buffer.concat([data.subarray(0, 40), Buffer.from([0, 5]), data.subarray(41)]);
    h.putAccount(at, partial, RECEIVER);
    await h.nextSlot();
    assert.match(await h.refusal(spike(h, at)), INSUFFICIENT_VERIFICATION);
  });

  // P0 review r1 (MINOR): exercise Account<PriceUpdateV2>'s own validation, not only the SDK's price checks.
  it("refuses a wrong discriminator on a receiver-owned account", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    const wrong = Buffer.from(data);
    wrong[0] = wrong[0]! ^ 0xff;
    h.putAccount(at, wrong, RECEIVER);
    await h.nextSlot();
    assert.match(await h.refusal(spike(h, at)), DISCRIMINATOR_MISMATCH);
  });

  it("refuses a truncated receiver-owned account", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    h.putAccount(at, data.subarray(0, 100), RECEIVER);
    await h.nextSlot();
    assert.match(await h.refusal(spike(h, at)), DID_NOT_DESERIALIZE);
  });

  it("records what trailing bytes after a valid PriceUpdateV2 do (only the receiver can create such an account)", async () => {
    const at = anchor.web3.Keypair.generate().publicKey;
    h.putAccount(at, Buffer.concat([data, Buffer.alloc(10)]), RECEIVER);
    await h.nextSlot();
    const meta = await spike(h, at);
    // Anchor deserializes the struct and ignores the rest: accepted, same price. Stated, not assumed.
    assert.equal(Buffer.from(meta.returnData!.data).readBigInt64LE(0), PRICE);
  });
});
