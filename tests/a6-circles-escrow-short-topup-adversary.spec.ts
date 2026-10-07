/**
 * A6 adversary (on 1417e60): a round the program refuses as RoundNotFunded because the escrow cannot pay a defaulted
 * seat's share is unblocked only by a top-up (top_up_reserve fills escrow_deficit first, escrow += fill), and the
 * recipient may send it (member, not defaulted, Active). The shared list's brief: each card's next step matches the
 * chain for that wallet (top up among them), a step the chain would accept is not hidden behind a wrong state, and
 * Needs-you counts the recipient's top up. SPEC.md copy, "Round not funded: escrow short": "Any member tops up
 * {short_by} USDC; the first {deficit} prepays {name}'s contributions". lib/core/circle-list.ts cites that row for
 * escrowDeficit, but lib/core/circle-card.ts reaches the top-up only through `v.releasable`, which is false here, so
 * the recipient reads an ordinary "Round 5 of 5: Seat 5 receives 250 USDC" with "Open circle", outside Needs-you.
 *
 * Fixture: the design's demo circle (app/src/fixtures/circles.ts: n 5, c 50, g 35, R 175, H 132 per seat at 150/150),
 * walked forward with the program's own formulas:
 *   round 1: Ada (seat 1, received round 0, rounds_paid 1) declared in default after a price fall that recovers only
 *     20 USDC for all her stock (declare_default.rs, SPEC §6): O = 50 x (5 - 1) = 200, shortfall 180,
 *     loss = min(180, R - L = 175) = 175, escrow = 20 + 175 = 195, escrow_deficit = 180 - 175 = 5, reserve_losses 175.
 *     Tunde adds stock (add_stock) so his round-1 gate need is met by stock; the price recovers to 150.
 *   rounds 1 to 3 release (release_pot.rs): each takes 50 from the escrow for Ada's seat: escrow 195 - 150 = 45.
 *     After round 3's release, next_gate_short_by = short_by(next_needed 0 (O = 50 x (5 - 4 - 1) = 0), remaining 0,
 *     deficit 5) = 5.
 *   round 4 (Nneka's): seats 2 to 5 paid, Ada defaulted and unpaid, escrow 45 < 50 owed: release_pot refuses
 *     RoundNotFunded. A top-up of 5 by Nneka fills the deficit (escrow 50) and the release then passes.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-escrow-short-topup-adversary.spec.ts
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
  pool: { discountBps: 2000, usdc: 0 },
  readAt: FIXTURE_NOW,
});

describe("A6 adversary: an escrow-short round hides the recipient's top-up", () => {
  const base = CIRCLE_STATES.active;
  const v: CircleView = {
    ...base,
    round: 4,
    roundDeadline: FIXTURE_NOW + 74,
    paidBitmap: 0b11110,
    receivedBitmap: 0b01111,
    defaultedBitmap: 0b00001,
    reserveTotal: 175 * USDC,
    reserveLosses: 175 * USDC,
    reserveAllocated: 0,
    escrow: 45 * USDC,
    escrowDeficit: 5 * USDC,
    nextGateShortBy: 5 * USDC,
    heldContributions: 200 * USDC,
    members: base.members.map((m) =>
      m.turn === 0 ? { ...m, lockedRaw: 0, roundsPaid: 4, allocated: 0 } : { ...m, lockedRaw: m.turn === 1 ? 2 * m.lockedRaw : m.lockedRaw, roundsPaid: 5, allocated: 0 },
    ),
  };
  const nneka = v.members.find((m) => m.turn === v.round)!.address;

  it("precondition: release_pot refuses (escrow < contribution x defaulted-unpaid seats), a top-up of the deficit cures it", () => {
    assert.equal(releaseBlock(v, FIXTURE_NOW), "escrow-short");
    // top_up_reserve.rs: fill = min(escrow_deficit, amount); escrow += fill
    const fill = Math.min(v.escrowDeficit, v.nextGateShortBy);
    assert.equal(releaseBlock({ ...v, escrow: v.escrow + fill, escrowDeficit: v.escrowDeficit - fill }, FIXTURE_NOW), null);
  });

  it("the recipient's card offers the top-up that releases the pot, and Needs-you counts it", () => {
    const card = circleCard(solToList(live(v), nneka), nneka);
    assert.deepEqual(
      { group: card.group, action: card.action, namesAmount: card.headline.includes("5 USDC") },
      { group: "needs", action: "Top up", namesAmount: true },
      `card read: [${card.group}] ${card.band}: "${card.headline}" (${card.action})`,
    );
  });
});
