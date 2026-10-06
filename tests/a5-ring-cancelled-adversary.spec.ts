/**
 * Adversary, A5 (Robinhood circle page, Joshua 2026-10-05), pass on 77f0185. Spec item 1: the ring's seat states,
 * also given as text, are derived from the live read. A cancelled circle (evm/src/OthelloCircle.sol cancelCircle:
 * Forming only, by the creator) never activates, so no seat will ever receive a round's pot; the only thing left is
 * withdraw(). ringOf must not tell a seat of a cancelled circle that it "receives in round N".
 *
 * State: n=3, the creator (seat 1) and seat 3 joined, seat 2 never joined, then cancelCircle(); round 0, nothing
 * received, joined seats hold collateral and guarantee (as joinAndLock leaves them), seat 2 is empty.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-ring-cancelled-adversary.spec.ts
 */
import assert from "node:assert/strict";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { ringOf } from "../app/src/lib/robinhood/circle-view.ts";

const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;

function seat(turn: number, joined: boolean): RhSeat {
  return { turn, wallet: W(turn), collateral: joined ? 10n * U : 0n, g: joined ? U : 0n, topUps: 0n, forfeited: 0n, allocated: 0n,
    lastCoverageBps: 0, delinquentMarks: 0, roundsPaid: 0, joined, paid: false, received: false, defaulted: false, marked: false, withdrawn: false };
}

const cancelled: RhCircleView = {
  address: W(9), factory: W(8), creator: W(0), n: 3, c: 2n * U, g: U, minStockCover: 9n * U, haircutBps: 1000, coverageBps: 10000,
  warnBps: 10000 - 1, roundSecs: 86_400, graceSecs: 3_600, status: "Cancelled", round: 0, deadline: 0,
  reserveTotal: 2n * U, reserveLosses: 0n, reserveAllocated: 0n, escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n,
  collateralReturned: 0n, depositsTotal: 2n * U, forfeitedTotal: 0n, nextGateShortBy: 0n, heldContributions: 0n, lastCoverageAt: 0,
  balance: 22n * U, surplus: 0n, seats: [seat(0, true), seat(1, false), seat(2, true)], readAt: 0, chainTime: 0, block: 1,
};

describe("A5 adversary: a cancelled circle's seats are not told they will receive a pot", () => {
  it("no seat status of a cancelled circle says it receives in a future round", () => {
    const ring = ringOf(cancelled, W(0));
    for (const s of ring.seats) {
      assert.doesNotMatch(s.status, /receives in round/, `${s.label} of a cancelled circle reads: "${s.status}"`);
    }
  });
});
