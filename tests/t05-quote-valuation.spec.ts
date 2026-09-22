/**
 * T05: quote_valuation, and invariants I12 and I13.
 *
 *   I12 "10-for-1 split with price updated for multiplier 10: H unchanged
 *        within 1 base unit"
 *   I13 "Price stamped for a different multiplier than the effective one:
 *        ... refuse"
 *
 * This is the gate's whole claim in one test file. The same position, valued
 * either side of a real 10-for-1 split on the real NFLXx mint, must be worth
 * the same, while a reader that ignores the multiplier loses 90% of it.
 *
 * SPEC §5 demo numbers: 1.1 token, wrapper 150 and share 150 before, wrapper
 * 150 and share 15 after, haircut 2000 -> H = 132 on both sides.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  call,
  FIXTURE_MINTS,
  harness,
  priceFeedAddress,
  send,
  type Harness,
} from "./harness.ts";

const { BN } = (anchor as unknown as { default: { BN: new (value: number | string) => unknown } })
  .default;

const SPLIT_AT = 1_763_337_300;
const BEFORE_SPLIT = SPLIT_AT - 1;

const ONE_X = 1_000_000_000;
const TEN_X = 10_000_000_000;

/** USDC base units, 6 dp. */
const USDC = 1_000_000;
/** Raw base units, 8 dp. 1.1 token. */
const RAW = 110_000_000;

const WRAPPER = 150 * USDC;
const SHARE_BEFORE = 150 * USDC;
const SHARE_AFTER = 15 * USDC;

const HAIRCUT_BPS = 2000;
const MAX_PRICE_AGE = 691_200;

const EXPECTED_FUND = 165 * USDC;
const EXPECTED_H = 132 * USDC;

const CURRENT = { current: {} };
const SCHEDULED = { scheduled: {} };

type Quote = { multFixed: bigint; fund: bigint; exec: bigint; h: bigint; computeUnits: bigint };

describe("T05 quote_valuation (I12, I13)", () => {
  let h: Harness;
  let mint: anchor.web3.PublicKey;
  let feed: anchor.web3.PublicKey;

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    mint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
    feed = priceFeedAddress(h.program, mint);

    await h.setClock(BEFORE_SPLIT);
    await call(h.program, "initPriceFeed")
      .accounts({ authority: h.authority.publicKey, stockMint: mint, feed })
      .signers([h.authority])
      .rpc();
  });

  const setPrices = (share: number, stamp: unknown, expected: number) =>
    call(h.program, "setPrices", [new BN(WRAPPER), new BN(share), stamp, new BN(expected)])
      .accounts({ authority: h.authority.publicKey, stockMint: mint, feed })
      .signers([h.authority])
      .rpc();

  const quoteIx = (raw: number | string = RAW, haircutBps = HAIRCUT_BPS, maxAge = MAX_PRICE_AGE) =>
    call(h.program, "quoteValuation", [new BN(raw), haircutBps, new BN(maxAge)])
      .accounts({ stockMint: mint, feed })
      .instruction();

  async function quote(raw = RAW): Promise<Quote> {
    const meta = await send(h, await quoteIx(raw));

    assert.ok(meta.returnData, "quote_valuation returned no data");

    const bytes = Buffer.from(meta.returnData.data);
    assert.equal(bytes.length, 32, "expected four u64s");

    return {
      multFixed: bytes.readBigUInt64LE(0),
      fund: bytes.readBigUInt64LE(8),
      exec: bytes.readBigUInt64LE(16),
      h: bytes.readBigUInt64LE(24),
      computeUnits: meta.computeUnitsConsumed,
    };
  }

  it("values the demo position before the split", async () => {
    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);

    const q = await quote();

    assert.equal(q.multFixed, BigInt(ONE_X));
    assert.equal(q.fund, BigInt(EXPECTED_FUND), "FUND");
    assert.equal(q.exec, BigInt(EXPECTED_FUND), "EXEC");
    assert.equal(q.h, BigInt(EXPECTED_H), "H");
  });

  // I12, the go/no-go. Same position, same worth, across a real 10-for-1.
  it("I12: H is unchanged across the split, to the base unit", async () => {
    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);
    const before = await quote();

    // The admin schedules the split's prices while the old ones are still live.
    await setPrices(SHARE_AFTER, SCHEDULED, TEN_X);
    await h.setClock(SPLIT_AT);
    const after = await quote();

    assert.equal(after.multFixed, BigInt(TEN_X), "the multiplier really changed");
    assert.equal(after.h, before.h, "H moved across the split");
    assert.equal(after.h, BigInt(EXPECTED_H));
    assert.equal(after.fund, BigInt(EXPECTED_FUND));
    assert.equal(after.exec, BigInt(EXPECTED_FUND));
  });

  it("is worth ten times what a reader that ignores the multiplier would say", async () => {
    await setPrices(SHARE_AFTER, SCHEDULED, TEN_X);
    await h.setClock(SPLIT_AT);

    const q = await quote();
    const naive = BigInt(RAW) * BigInt(SHARE_AFTER) / 100_000_000n;

    assert.equal(naive, 16_500_000n, "the naive read is 16.5 USDC");
    assert.equal(q.fund, naive * 10n, "the correct read is ten times it");
  });

  // I13.
  it("I13: refuses while the stamp and the effective multiplier disagree", async () => {
    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);
    await h.setClock(SPLIT_AT);

    assert.equal(await h.refusal(send(h, await quoteIx())), "MultiplierPriceMismatch");
  });

  it("refuses a price older than max_price_age, and an unpriced feed", async () => {
    assert.equal(await h.refusal(send(h, await quoteIx())), "PriceStale", "never priced");

    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);
    await h.setClock(BEFORE_SPLIT + MAX_PRICE_AGE + 1);

    assert.equal(await h.refusal(send(h, await quoteIx())), "PriceStale", "one second too old");
  });

  it("counts the lower of FUND and EXEC, and floors the haircut", async () => {
    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);

    // 1 raw unit: FUND = EXEC = floor(1 x 150e6 / 1e8) = 1 base unit.
    // H = floor(1 x 8000 / 10000) = 0. Collateral rounds down, always.
    const q = await quote(1);

    assert.equal(q.fund, 1n);
    assert.equal(q.exec, 1n);
    assert.equal(q.h, 0n, "H rounded up instead of down");
  });

  it("refuses a position too large to value, rather than wrapping", async () => {
    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);

    // u64::MAX raw. The u128 product survives, but FUND lands at 2.77e19,
    // past u64::MAX at 1.84e19, so the narrowing is what has to refuse. Release
    // builds set overflow-checks, so a wrap would abort rather than lie, but a
    // named refusal beats an abort.
    assert.equal(
      await h.refusal(send(h, await quoteIx("18446744073709551615"))),
      "ValuationOverflow",
    );
  });

  it("refuses a haircut of 100% or more, and a non-positive max age", async () => {
    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);

    assert.equal(await h.refusal(send(h, await quoteIx(RAW, 10_000))), "InvalidParams");
    assert.equal(await h.refusal(send(h, await quoteIx(RAW, HAIRCUT_BPS, 0))), "InvalidParams");
  });

  it("records the compute units SPEC section 10 asks for", async () => {
    await setPrices(SHARE_BEFORE, CURRENT, ONE_X);

    const q = await quote();

    console.log(`      quote_valuation compute units: ${q.computeUnits}`);
    assert.ok(q.computeUnits < 200_000n, "quote_valuation does not fit the default CU limit");
  });
});
