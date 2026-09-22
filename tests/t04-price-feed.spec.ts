/**
 * T04: the PriceFeed, and invariant I17.
 *
 *   "set_prices never binds a share price to a multiplier the script did not
 *    name; touch_prices never changes prices or stamp."
 *
 * Driven through real Anchor calls against bankrun, with the REAL NFLXx mint at
 * its real mainnet address, so the multiplier the program stamps comes from
 * mainnet bytes rather than from anything this test made up. NFLXx is a real
 * 10-for-1 split at 1763337300 (SPEC §9b.1), which is what makes the "Scheduled
 * then Current" case in I17 a real scenario and not a contrivance.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  BEFORE_SPLIT,
  call,
  CURRENT,
  FIXTURE_MINTS,
  harness,
  initFeed,
  ONE_X,
  priceFeedAddress,
  readFeed as readFeedOf,
  SCHEDULED,
  setPrices as setPricesOn,
  SPLIT_AT,
  TEN_X,
  USDC,
  type Harness,
} from "./harness.ts";

/** The demo's pre-split prices (SPEC §5): wrapper 150, share 150. */
const WRAPPER_BEFORE = 150 * USDC;
const SHARE_BEFORE = 150 * USDC;
/** After a 10-for-1, the same wrapper is ten times as many shares. */
const SHARE_AFTER = 15 * USDC;

describe("T04 PriceFeed (I17)", () => {
  let h: Harness;
  let mint: anchor.web3.PublicKey;
  let feed: anchor.web3.PublicKey;

  async function openFeed(): Promise<void> {
    h = await harness(["NFLXx"]);
    mint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
    feed = priceFeedAddress(h.program, mint);

    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, mint);
  }

  const setPrices = (
    wrapper: number,
    share: number,
    stamp: unknown,
    expected: number,
    signer = h.authority,
  ) => setPricesOn(h, mint, { wrapper, share, stamp, expected, signer });

  const touch = (signer = h.authority) =>
    call(h.program, "touchPrices")
      .accounts({ authority: signer.publicKey, feed })
      .signers([signer])
      .rpc();

  const readFeed = () => readFeedOf(h, mint);

  beforeEach(openFeed);

  it("starts unpriced, bound to its own mint", async () => {
    const state = await readFeed();

    assert.equal(state.stockMint.toBase58(), mint.toBase58());
    assert.equal(state.authority.toBase58(), h.authority.publicKey.toBase58());
    assert.equal(state.wrapperPrice.toNumber(), 0);
    assert.equal(state.pricedForMultiplier.toNumber(), 0);
  });

  it("stamps Current with the multiplier in force, read from the real mint", async () => {
    await setPrices(WRAPPER_BEFORE, SHARE_BEFORE, CURRENT, ONE_X);

    const state = await readFeed();

    assert.equal(state.pricedForMultiplier.toNumber(), ONE_X);
    assert.equal(state.sharePrice.toNumber(), SHARE_BEFORE);
    assert.equal(state.updatedAt.toNumber(), BEFORE_SPLIT);
  });

  it("stamps Scheduled with the multiplier that is coming, not the one in force", async () => {
    await setPrices(WRAPPER_BEFORE, SHARE_AFTER, SCHEDULED, TEN_X);

    assert.equal((await readFeed()).pricedForMultiplier.toNumber(), TEN_X);
  });

  // I17, first half: the script names the multiplier and the program checks it.
  it("refuses prices whose named multiplier is not the one the stamp would write", async () => {
    assert.equal(
      await h.refusal(setPrices(WRAPPER_BEFORE, SHARE_BEFORE, CURRENT, TEN_X)),
      "MultiplierPriceMismatch",
      "Current stamp, but the script claimed the post-split multiplier",
    );
    assert.equal(
      await h.refusal(setPrices(WRAPPER_BEFORE, SHARE_AFTER, SCHEDULED, ONE_X)),
      "MultiplierPriceMismatch",
      "Scheduled stamp, but the script claimed the pre-split multiplier",
    );
  });

  // I17, the case SPEC §10 names: a Scheduled stamp is pending, and someone
  // tries to put the old share price back as Current before the split lands.
  // Allowing it would value the collateral at a tenth.
  it("refuses a Current stamp while a Scheduled stamp is still pending", async () => {
    await setPrices(WRAPPER_BEFORE, SHARE_AFTER, SCHEDULED, TEN_X);

    assert.equal(
      await h.refusal(setPrices(WRAPPER_BEFORE, SHARE_BEFORE, CURRENT, ONE_X)),
      "MultiplierPriceMismatch",
    );

    const state = await readFeed();
    assert.equal(state.pricedForMultiplier.toNumber(), TEN_X, "the pending stamp survived");
    assert.equal(state.sharePrice.toNumber(), SHARE_AFTER, "the post-split price survived");
  });

  it("accepts a Current stamp once the split second has arrived", async () => {
    await setPrices(WRAPPER_BEFORE, SHARE_AFTER, SCHEDULED, TEN_X);
    await h.setClock(SPLIT_AT);

    // Current now means 10x, so the script must name 10x.
    await setPrices(WRAPPER_BEFORE, SHARE_AFTER, CURRENT, TEN_X);

    assert.equal((await readFeed()).pricedForMultiplier.toNumber(), TEN_X);
  });

  // I17, second half.
  it("touch_prices moves only updated_at", async () => {
    await setPrices(WRAPPER_BEFORE, SHARE_AFTER, SCHEDULED, TEN_X);
    const before = await readFeed();

    await h.setClock(BEFORE_SPLIT + 3600);
    await touch();

    const after = await readFeed();

    assert.equal(after.updatedAt.toNumber(), BEFORE_SPLIT + 3600, "updated_at did not move");
    assert.equal(after.wrapperPrice.toNumber(), before.wrapperPrice.toNumber());
    assert.equal(after.sharePrice.toNumber(), before.sharePrice.toNumber());
    assert.equal(
      after.pricedForMultiplier.toNumber(),
      before.pricedForMultiplier.toNumber(),
      "touch_prices re-stamped the multiplier",
    );
  });

  it("refuses a zero price", async () => {
    assert.equal(await h.refusal(setPrices(0, SHARE_BEFORE, CURRENT, ONE_X)), "InvalidParams");
    assert.equal(await h.refusal(setPrices(WRAPPER_BEFORE, 0, CURRENT, ONE_X)), "InvalidParams");
  });

  it("refuses both admin instructions from a wallet that is not the authority", async () => {
    const stranger = h.fund();

    assert.equal(
      await h.refusal(setPrices(WRAPPER_BEFORE, SHARE_BEFORE, CURRENT, ONE_X, stranger)),
      "Unauthorized",
    );
    assert.equal(
      await h.refusal(touch(stranger)),
      "Unauthorized",
    );
  });
});
