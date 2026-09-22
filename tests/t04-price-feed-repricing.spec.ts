/**
 * T04: the other side of the pending-stamp predicate.
 *
 * SPEC §5 states exactly one condition under which set_prices refuses a stamp
 * on top of an existing one:
 *
 *   "stamp = Current refused while a Scheduled stamp is pending
 *    (feed.priced_for = mint.newMultiplier and its effective time is in the
 *    future)"
 *
 * Everything else the admin script can do, it must be allowed to do. The
 * existing t04 suite pins the predicate only where it refuses, so two
 * non-equivalent mutants of it survive all nine of those tests: widening the
 * guard to every stamp, and replacing `feed.priced_for == mint.newMultiplier`
 * with `feed.priced_for != 0`. Both freeze a feed the spec says must stay
 * writable, and a frozen feed goes stale, which under §5 Price freshness stops
 * release_pot, update_coverage and join_and_lock outright.
 *
 * Real NFLXx mint bytes at the real mainnet address (SPEC §9b.1), warped to one
 * second before its real 10-for-1 at 1763337300, so the split these two cases
 * sit inside is a real one.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  BEFORE_SPLIT,
  CURRENT,
  FIXTURE_MINTS,
  harness,
  initFeed,
  ONE_X,
  readFeed as readFeedOf,
  SCHEDULED,
  setPrices as setPricesOn,
  TEN_X,
  USDC,
  type Harness,
} from "./harness.ts";

const WRAPPER_BEFORE = 150 * USDC;
const SHARE_BEFORE = 150 * USDC;
const SHARE_AFTER = 15 * USDC;

/** A later quote of the same stock, so the second call is a real re-quote. */
const WRAPPER_MOVED = 151 * USDC;
const SHARE_BEFORE_MOVED = 151 * USDC;
const SHARE_AFTER_MOVED = 15_100_000;

describe("T04 PriceFeed: what repricing must still permit (I17)", () => {
  let h: Harness;
  let mint: anchor.web3.PublicKey;

  const setPrices = (wrapper: number, share: number, stamp: unknown, expected: number) =>
    setPricesOn(h, mint, { wrapper, share, stamp, expected });

  const readFeed = () => readFeedOf(h, mint);

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    mint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);

    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, mint);
  });

  // Only Current is refused while a Scheduled stamp is pending. A Scheduled
  // re-quote names the same multiplier the feed already carries, so it cannot
  // bind a price to the wrong one, and the script needs it: the stock keeps
  // trading between the moment the split is scheduled and the moment it lands.
  it("accepts a second Scheduled stamp while the first is still pending", async () => {
    await setPrices(WRAPPER_BEFORE, SHARE_AFTER, SCHEDULED, TEN_X);

    await setPrices(WRAPPER_MOVED, SHARE_AFTER_MOVED, SCHEDULED, TEN_X);

    const state = await readFeed();

    assert.equal(state.sharePrice.toNumber(), SHARE_AFTER_MOVED, "the re-quote did not land");
    assert.equal(state.wrapperPrice.toNumber(), WRAPPER_MOVED);
    assert.equal(state.pricedForMultiplier.toNumber(), TEN_X, "still bound to the named multiplier");
  });

  // Pending is a property of THIS feed, not of the mint alone: it is
  // feed.priced_for == mint.newMultiplier AND the effective time is ahead. A
  // feed stamped for the multiplier in force is not pending, even though the
  // mint has a real split scheduled, so Current must still be accepted. This is
  // the demo's own position: all five members join before the split is
  // scheduled, and the pre-split price is quoted for multiplier 1.
  it("accepts a Current stamp when the feed is not stamped for the coming split", async () => {
    await setPrices(WRAPPER_BEFORE, SHARE_BEFORE, CURRENT, ONE_X);

    await setPrices(WRAPPER_MOVED, SHARE_BEFORE_MOVED, CURRENT, ONE_X);

    const state = await readFeed();

    assert.equal(state.sharePrice.toNumber(), SHARE_BEFORE_MOVED, "the re-quote did not land");
    assert.equal(state.wrapperPrice.toNumber(), WRAPPER_MOVED);
    assert.equal(state.pricedForMultiplier.toNumber(), ONE_X, "still bound to the named multiplier");
    assert.equal(state.updatedAt.toNumber(), BEFORE_SPLIT, "the feed did not go stale");
  });
});
