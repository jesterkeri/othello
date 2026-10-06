/**
 * A6 adversary: on Solana, release_pot refuses RoundNotFunded when the escrow cannot pay the defaulted seats' share of
 * this round (programs/othello/src/instructions/release_pot.rs: `if missing_seats != 0 || circle.escrow < escrow_owed`).
 * The spec for the shared circles list says the Solana claim must follow releaseBlock, "which must match what
 * release_pot checks"; Robinhood's releaseButton already blocks the same case (`v.escrow < need`). Fixture: the design's
 * active circle (app/src/fixtures/circles.ts) with Ada (seat 1, who received in round 0) declared in default and the
 * escrow short after a waterfall that left a deficit (declare_default.rs adds to escrow_deficit what nothing covered).
 *
 *   npx mocha --import=tsx tests/a6-release-escrow-short-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { CIRCLE_STATES, FIXTURE_NOW } from "../app/src/fixtures/circles.ts";
import { releaseBlock, type CircleView } from "../app/src/lib/circle.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";
import type { LiveCircle } from "../app/src/lib/live.ts";
import { solToList } from "../app/src/lib/to-list-solana.ts";

const ADDR = "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q";
const USDC = 1_000_000;
const live = (view: CircleView): LiveCircle => ({
  view,
  accounts: { circle: ADDR, usdcMint: "x", stockMint: "y" },
  split: { multiplier: 1e9, newMultiplier: 1e9, effectiveAt: 0 },
  pool: { discountBps: 0, usdc: 0 },
  readAt: FIXTURE_NOW,
});

describe("A6 adversary: Solana claim while the escrow cannot fund the defaulted seat", () => {
  // round 1: seats 2 to 5 paid, Ada (seat 1, received round 0) in default and unpaid, escrow 10 USDC against 50 owed
  const v: CircleView = {
    ...CIRCLE_STATES.active,
    paidBitmap: 0b11110,
    defaultedBitmap: 0b00001,
    escrow: 10 * USDC,
    escrowDeficit: 140 * USDC,
  };
  const recipient = v.members.find((m) => m.turn === v.round)!.address;

  it("release_pot would refuse (escrow < contribution x defaulted-unpaid seats), so releaseBlock must not be null", () => {
    const escrowOwed = v.contribution * 1;
    assert.ok(v.escrow < escrowOwed, "precondition: the program's RoundNotFunded branch");
    assert.notEqual(releaseBlock(v, FIXTURE_NOW), null);
  });

  it("the list does not offer this round's recipient a Claim the program refuses", () => {
    const l = solToList(live(v), recipient);
    assert.equal(l.releasable, false);
    const card = circleCard(l, recipient);
    assert.notEqual(card.action, "Claim", card.headline);
  });
});
