/**
 * B2 adversary on e7959b0: minJoinStock names a least of 2^64 raw, one past the largest amount join_and_lock takes.
 *
 *   Spec 1 (PR 2 brief): "Its amount is prefilled with the least stock the program accepts (join_and_lock's
 *   CollateralBelowMinimum rule, exactly ...)". lib/circle.ts minJoinStock: "Null when no amount can reach it".
 *
 * join_and_lock takes `stock_raw: u64`, so the largest amount it can value is 2^64 - 1. minJoinStock doubles `hi` up
 * to 2^64 and binary-searches (lo, hi], so when counted(2^64 - 1) < min_stock_cover <= counted(2^64) it returns 2^64:
 * a figure no transaction can carry, while every u64 amount is refused CollateralBelowMinimum. The page then prefills
 * "184467440737.09551616" and says "This circle needs at least" that, instead of "No amount of stock reaches this
 * circle's minimum cover at the current price."
 *
 * Input: the demo circle's state (app/src/fixtures/circles.ts, haircut 20%, x1, priced for x1) with both prices at
 * 18667 (0.018667 test USDC a token) and min_stock_cover 2754762972991489, under 2^53 so lib/live.ts reads it. Found by
 * search: floor(floor(r * 18667 / 1e8) * 8000 / 1e4) is 2754762972991488 at r = 2^64 - 1 and one more at r = 2^64.
 *
 *   npx mocha --import=tsx --timeout 600000 tests/b2-min-join-stock-past-u64-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { CIRCLE_STATES } from "../app/src/fixtures/circles.ts";
import { countedOfRaw, minJoinStock, valuationOverflows, type CircleView } from "../app/src/lib/circle.ts";

const U64_MAX = (1n << 64n) - 1n;
const A = CIRCLE_STATES.active;
const view: CircleView = {
  ...A,
  status: "Forming",
  minStockCover: 2754762972991489,
  feed: { ...A.feed, wrapperPrice: 18667, sharePrice: 18667 },
};

describe("B2 adversary on e7959b0: a minimum cover no u64 amount reaches", () => {
  it("names no least when even u64::MAX raw counts less than min_stock_cover", () => {
    assert.ok(Number.isSafeInteger(view.minStockCover), "precondition: lib/live.ts can read this min_stock_cover");
    assert.equal(valuationOverflows(view, U64_MAX), false, "precondition: the program can value u64::MAX raw");
    assert.ok(countedOfRaw(view, U64_MAX) < BigInt(view.minStockCover), "precondition: join_and_lock refuses every u64 amount (CollateralBelowMinimum)");
    const least = minJoinStock(view);
    assert.equal(least, null, `minJoinStock names ${least} raw, past u64::MAX (${U64_MAX})`);
  });
});
