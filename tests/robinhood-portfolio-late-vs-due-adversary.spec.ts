/**
 * Adversary, Robinhood portfolio "Your circle" card (app/src/lib/robinhood/portfolio-circle.ts pickCircle), pass on
 * c0f5b95. Spec item 1: the card shows the wallet's "most relevant running circle among those it read".
 *
 * pickCircle ranks the circles where the wallet must pay by the round deadline alone. Grace differs per circle (the
 * factory accepts 30 s to 30 days, evm/src/OthelloFactory.sol createCircle), so a circle whose deadline passed earlier
 * but whose grace is long (still "due") beats a circle already past deadline plus grace ("late": markDelinquent and,
 * after the pot, declareDefault are open on it now). The card then reads "your payment is due" and hides the circle
 * where the seat can already be settled in default.
 *
 * The views are built like tests/robinhood-portfolio-circle.spec.ts builds them (the RhCircleView readCircle returns);
 * only deadline, graceSecs and chainTime differ between the two circles.
 *
 *   npx mocha --import=tsx tests/robinhood-portfolio-late-vs-due-adversary.spec.ts
 */
import assert from "node:assert/strict";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { circleCard, pickCircle } from "../app/src/lib/robinhood/portfolio-circle.ts";

const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;
const ME = W(2);

function seat(turn: number, over: Partial<RhSeat> = {}): RhSeat {
  return { turn, wallet: W(turn), collateral: 10n * U, g: U, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: 0, delinquentMarks: 0,
    roundsPaid: 0, joined: true, paid: false, received: false, defaulted: false, marked: false, withdrawn: false, ...over };
}
function circle(addr: number, over: Partial<RhCircleView>): RhCircleView {
  const seats = Array.from({ length: 3 }, (_, i) => seat(i));
  return { address: W(addr), factory: W(8), creator: W(0), n: 3, c: 2n * U, g: U, minStockCover: 10n * U, haircutBps: 1000, coverageBps: 10000, warnBps: 0,
    roundSecs: 86_400, graceSecs: 3_600, status: "Active", round: 0, deadline: 1_000, reserveTotal: 0n, reserveLosses: 0n, reserveAllocated: 0n,
    escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n, collateralReturned: 0n, depositsTotal: 0n, forfeitedTotal: 0n, nextGateShortBy: 0n,
    heldContributions: 0n, lastCoverageAt: 0, balance: 0n, surplus: 0n, seats, readAt: 0, chainTime: 0, block: 1, ...over };
}

describe("Robinhood portfolio adversary: a late circle loses the card to a due one with an earlier deadline", () => {
  it("the card shows the circle where the wallet's payment is already late, not one still inside a long grace", () => {
    const now = 1_000_000;
    // due: deadline 1000 s ago, 30 days of grace left to run
    const due = circle(20, { deadline: now - 1_000, graceSecs: 2_592_000, chainTime: now });
    // late: deadline 500 s ago, 30 s grace, so past grace by chain time
    const late = circle(21, { deadline: now - 500, graceSecs: 30, chainTime: now });
    assert.equal(circleCard(due, ME)!.late, false, "precondition: the first circle is only due");
    assert.equal(circleCard(late, ME)!.late, true, "precondition: the second circle is late");

    const shown = pickCircle([due, late], ME)!;
    const card = circleCard(shown, ME)!;
    assert.equal(
      shown.address,
      late.address,
      `the wallet is late in ${late.address} (markDelinquent open since ${now - 470}), yet the card shows ${shown.address}: "${card.sub} · your payment is ${card.late ? "late" : "due"}"`,
    );
  });
});
