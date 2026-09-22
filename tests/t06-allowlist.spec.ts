/**
 * T06: the real fixtures end to end, and the mint allowlist (ADR-012).
 *
 * "Collateral is identified by mint ADDRESS, never by symbol: Jupiter returns
 *  five tokens named NFLXx and one of them is real."
 *
 * So the case that matters is not a malformed mint. It is a PERFECT one: bytes
 * copied from a real xStock, carrying Backed's own authorities and metadata,
 * sitting at an address nobody vetted. Nothing on-chain distinguishes it
 * (SPEC §9b.6). Only the address does.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO } from "./artifacts.ts";
import {
  call,
  FIXTURE_MINTS,
  fixture,
  harness,
  priceFeedAddress,
  send,
  type FixtureSymbol,
  type Harness,
} from "./harness.ts";

const { BN } = (anchor as unknown as { default: { BN: new (value: number | string) => unknown } })
  .default;

const SYMBOLS = Object.keys(FIXTURE_MINTS) as FixtureSymbol[];

const USDC = 1_000_000;
const RAW = 110_000_000;
const WRAPPER = 150 * USDC;
const HAIRCUT_BPS = 2000;
const MAX_PRICE_AGE = 691_200;
const CURRENT = { current: {} };

/** Before every fixture's own scheduled change, so Current means `multiplier`. */
const BEFORE_ANY_CHANGE = 1_700_000_000;

describe("T06 real fixtures and the mint allowlist (ADR-012)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness(SYMBOLS);
    await h.setClock(BEFORE_ANY_CHANGE);
  });

  const initFeed = (mint: anchor.web3.PublicKey) =>
    call(h.program, "initPriceFeed")
      .accounts({ authority: h.authority.publicKey, stockMint: mint, feed: priceFeedAddress(h.program, mint) })
      .signers([h.authority])
      .rpc();

  const setPrices = (mint: anchor.web3.PublicKey, share: number, expected: string) =>
    call(h.program, "setPrices", [new BN(WRAPPER), new BN(share), CURRENT, new BN(expected)])
      .accounts({ authority: h.authority.publicKey, stockMint: mint, feed: priceFeedAddress(h.program, mint) })
      .signers([h.authority])
      .rpc();

  const quoteIx = (mint: anchor.web3.PublicKey) =>
    call(h.program, "quoteValuation", [new BN(RAW), HAIRCUT_BPS, new BN(MAX_PRICE_AGE)])
      .accounts({ stockMint: mint, feed: priceFeedAddress(h.program, mint) })
      .instruction();

  /** The multiplier the T00 fetcher recorded, as the program's fixed-point integer. */
  function recordedMultiplierFixed(symbol: FixtureSymbol): bigint {
    const recorded = JSON.parse(
      readFileSync(resolve(REPO, `tests/fixtures/${symbol}.json`), "utf8"),
    ) as { decodedScaledUiAmountConfig: { multiplier: number } };

    // floor(multiplier x 1e9), computed here in BigInt from the decimal the
    // fetcher recorded, not by asking the program.
    const [whole, fraction = ""] = recorded.decodedScaledUiAmountConfig.multiplier
      .toFixed(20)
      .split(".");

    return BigInt(`${whole}${fraction.slice(0, 9).padEnd(9, "0")}`);
  }

  it("values all four real mints, at their real mainnet addresses", async () => {
    for (const symbol of SYMBOLS) {
      const mint = new anchor.web3.PublicKey(FIXTURE_MINTS[symbol]);

      await initFeed(mint);

      const expected = recordedMultiplierFixed(symbol);
      await setPrices(mint, 150 * USDC, expected.toString());

      const meta = await send(h, await quoteIx(mint));
      assert.ok(meta.returnData, `${symbol}: no quote`);

      const bytes = Buffer.from(meta.returnData.data);
      const multFixed = bytes.readBigUInt64LE(0);
      const fund = bytes.readBigUInt64LE(8);
      const exec = bytes.readBigUInt64LE(16);
      const counted = bytes.readBigUInt64LE(24);

      assert.equal(multFixed, expected, `${symbol}: multiplier disagrees with the fixture`);
      assert.ok(fund > 0n && exec > 0n, `${symbol}: valued at nothing`);

      // SPEC §4 counts the LOWER of the two. These prices set share = wrapper,
      // so any mint whose multiplier is above 1 has FUND above EXEC and is
      // counted on EXEC. That is the point: a multiplier alone never inflates
      // collateral past what the raw token would actually fetch.
      const lower = fund < exec ? fund : exec;

      assert.equal(counted, (lower * 8000n) / 10_000n, `${symbol}: haircut not applied to min`);
      assert.equal(
        lower,
        exec,
        `${symbol}: with share = wrapper and multiplier >= 1, EXEC should be the lower`,
      );
    }
  });

  // The ADR-012 case, and the reason symbols are never trusted.
  it("refuses a byte-perfect copy of a real xStock at an unvetted address", async () => {
    const counterfeit = anchor.web3.Keypair.generate().publicKey;

    h.placeMint("NFLXx", counterfeit);

    // Identical bytes: same authorities, same metadata, same multiplier.
    const real = await h.context.banksClient.getAccount(
      new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx),
    );
    const fake = await h.context.banksClient.getAccount(counterfeit);

    assert.ok(real && fake);
    assert.deepEqual(
      Buffer.from(fake.data),
      Buffer.from(real.data),
      "the counterfeit is supposed to be byte-identical",
    );

    assert.equal(await h.refusal(initFeed(counterfeit)), "MintNotAllowed");
  });

  it("still refuses at quote time, even if a feed for an unvetted mint existed", async () => {
    const counterfeit = anchor.web3.Keypair.generate().publicKey;

    h.placeMint("NFLXx", counterfeit);

    // init_price_feed refuses, so write the feed straight into the harness to
    // reach the second check. Defence in depth is only worth having if it is
    // exercised.
    const feed = priceFeedAddress(h.program, counterfeit);
    const coder = h.program.coder.accounts;
    const data = await coder.encode("priceFeed", {
      authority: h.authority.publicKey,
      stockMint: counterfeit,
      bump: anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("price"), counterfeit.toBuffer()],
        h.program.programId,
      )[1],
      wrapperPrice: new BN(WRAPPER),
      sharePrice: new BN(150 * USDC),
      pricedForMultiplier: new BN(recordedMultiplierFixed("NFLXx").toString()),
      updatedAt: new BN(BEFORE_ANY_CHANGE),
    });

    h.context.setAccount(feed, {
      lamports: anchor.web3.LAMPORTS_PER_SOL,
      data,
      owner: h.program.programId,
      executable: false,
    });

    assert.equal(await h.refusal(send(h, await quoteIx(counterfeit))), "MintNotAllowed");
  });

  // Two sources of truth for the same four addresses; keep them identical.
  it("keeps the program allowlist and ops/xstock-mints.ts in step", async () => {
    const rust = readFileSync(resolve(REPO, "programs/othello/src/allowlist.rs"), "utf8");
    const ops = readFileSync(resolve(REPO, "ops/xstock-mints.ts"), "utf8");

    // Only the top-level consts, so the near-miss address inside the Rust test
    // module cannot be mistaken for an allowlist entry.
    const declared = [
      ...rust.matchAll(/^pub const [A-Z]+: Pubkey = Pubkey::from_str_const\("([^"]+)"\)/gm),
    ].map((m) => m[1]);
    const inOps = [...ops.matchAll(/address: "([1-9A-HJ-NP-Za-km-z]+)"/g)].map((m) => m[1]);

    assert.equal(declared.length, 4, "expected four allowlisted mints in allowlist.rs");
    assert.deepEqual(
      [...declared].sort(),
      [...inOps].sort(),
      "programs/othello/src/allowlist.rs and ops/xstock-mints.ts list different mints",
    );
    assert.deepEqual([...declared].sort(), [...Object.values(FIXTURE_MINTS)].sort());
  });

  it("every allowlisted mint has a committed fixture, and vice versa", () => {
    for (const symbol of SYMBOLS) {
      assert.equal(fixture(symbol).address, FIXTURE_MINTS[symbol]);
    }
  });
});
