/**
 * A6 adversary on 4e64417: the Solana circles list offers Join (Needs-you, "Your move") on a Forming circle whose
 * price feed is stale or Repricing, where join_and_lock refuses.
 *
 * join_and_lock values the stock with value_position (programs/othello/src/instructions/join_and_lock.rs, "a stale or
 * repricing feed refuses the join"), which requires now - updated_at <= max_price_age (PriceStale) and the feed's
 * stamp to equal the mint's effective multiplier (MultiplierPriceMismatch) (programs/othello/src/valuation.rs). The
 * chain side of that refusal is already proven on the real program: tests/t09-adversary.spec.ts ("SPEC §5
 * price_stale ...": a join one second past max_price_age is refused PriceStale; "I13: ..." refuses Repricing). The list
 * already reads both facts for Claim (lib/circle.ts releaseBlock: "stale", "repricing"), but circleCard's Forming
 * branch offers Join on `mine && !mine.joined` alone.
 *
 * Spec 1: "a step is offered only when the chain would accept it from this wallet"; "Needs-you counts only steps that
 * are this wallet's own (... join ...)", so a Join the chain refuses is neither offered nor counted.
 *
 * Fixtures: the design's Forming state (app/src/fixtures/circles.ts, two of five joined), the same CircleView the
 * Solana circle page renders, with only the feed's age or the mint's multiplier changed.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-join-stale-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { CIRCLE_STATES, FIXTURE_NOW } from "../app/src/fixtures/circles.ts";
import { isRepricing, isStale, type CircleView } from "../app/src/lib/circle.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";
import type { LiveCircle } from "../app/src/lib/live.ts";
import { solToList } from "../app/src/lib/to-list-solana.ts";

const ADDR = "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q";
const live = (view: CircleView): LiveCircle => ({
  view,
  accounts: { circle: ADDR, usdcMint: "x", stockMint: "y" },
  split: { multiplier: 1e9, newMultiplier: 1e9, effectiveAt: 0 },
  pool: { discountBps: 0, usdc: 0 },
  readAt: FIXTURE_NOW,
});

describe("A6 adversary: the Solana list offers Join where join_and_lock refuses the price", () => {
  const forming = CIRCLE_STATES.forming;
  const invitee = forming.members.find((m) => ((forming.joinedBitmap >> m.turn) & 1) === 0)!.address;

  it("the unmodified fixture is fresh and offers Join (control)", () => {
    assert.equal(isStale(forming, FIXTURE_NOW), false);
    assert.equal(isRepricing(forming), false);
    const card = circleCard(solToList(live(forming), invitee), invitee);
    assert.deepEqual([card.group, card.action], ["needs", "Join"]);
  });

  it("a feed one second past max_price_age (PriceStale on join): Join is not offered or counted", () => {
    const stale = { ...forming, feed: { ...forming.feed, updatedAt: FIXTURE_NOW - forming.maxPriceAge - 1 } };
    assert.equal(isStale(stale, FIXTURE_NOW), true, "the page's own rule calls this feed stale");
    const card = circleCard(solToList(live(stale), invitee), invitee);
    assert.ok(!(card.group === "needs" && card.action === "Join"),
      `join_and_lock refuses PriceStale, but the list offers "${card.headline}" (${card.action}) in ${card.group}`);
  });

  it("a feed stamped for another multiplier (MultiplierPriceMismatch on join): Join is not offered or counted", () => {
    const repricing = { ...forming, effectiveMultiplier: forming.effectiveMultiplier * 10 };
    assert.equal(isRepricing(repricing), true, "the page's own rule calls this Repricing");
    const card = circleCard(solToList(live(repricing), invitee), invitee);
    assert.ok(!(card.group === "needs" && card.action === "Join"),
      `join_and_lock refuses MultiplierPriceMismatch, but the list offers "${card.headline}" (${card.action}) in ${card.group}`);
  });
});
