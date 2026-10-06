/**
 * Adversary, A5 (Robinhood circle page, Joshua 2026-10-05), pass on 77f0185. Spec item 1: the ring highlights which
 * seats "have paid, are due, were covered by a locked promise (defaulted), or are late", from the live read. The read
 * carries the round deadline, graceSecs and the chain's own time (RhCircleView.chainTime). Once the chain is past
 * deadline + grace (evm/src/OthelloCircle.sol markDelinquent: block.timestamp > deadline + graceSecs) an unpaid seat
 * is late, and the page itself says so ("Waiting for a late payment", "Grace ended"). Nobody has to have called
 * markDelinquent yet for the payment to be late.
 *
 * State: n=3, Active, round 0, deadline 1_000_000, grace 3_600; the chain reads 2 hours past grace. Seat 1 paid,
 * seats 2 and 3 have not paid and are not marked. ringOf is given the chain time both in the read and as a third
 * argument, so a fix that passes the clock explicitly is tested the same way.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-ring-late-adversary.spec.ts
 */
import assert from "node:assert/strict";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { ringOf } from "../app/src/lib/robinhood/circle-view.ts";

const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;

function seat(turn: number, paid: boolean): RhSeat {
  return { turn, wallet: W(turn), collateral: 10n * U, g: U, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: 0,
    delinquentMarks: 0, roundsPaid: paid ? 1 : 0, joined: true, paid, received: false, defaulted: false, marked: false, withdrawn: false };
}

const deadline = 1_000_000;
const graceSecs = 3_600;
const chainTime = deadline + graceSecs + 7_200;
const active: RhCircleView = {
  address: W(9), factory: W(8), creator: W(0), n: 3, c: 2n * U, g: U, minStockCover: 9n * U, haircutBps: 1000, coverageBps: 10000,
  warnBps: 10000 - 1, roundSecs: 86_400, graceSecs, status: "Active", round: 0, deadline,
  reserveTotal: 3n * U, reserveLosses: 0n, reserveAllocated: 0n, escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n,
  collateralReturned: 0n, depositsTotal: 3n * U, forfeitedTotal: 0n, nextGateShortBy: 0n, heldContributions: 2n * U, lastCoverageAt: 0,
  balance: 35n * U, surplus: 0n, seats: [seat(0, true), seat(1, false), seat(2, false)], readAt: chainTime, chainTime, block: 1,
};

describe("A5 adversary: an unpaid seat past the grace period shows as late on the ring", () => {
  it("seats 2 and 3, unpaid two hours after grace ended, are late, not merely due", () => {
    const ring = (ringOf as (v: RhCircleView, me: string | null, now?: number) => ReturnType<typeof ringOf>)(active, W(0), chainTime);
    assert.deepEqual(ring.seats.map((s) => s.payment), ["paid", "late", "late"],
      `statuses: ${ring.seats.map((s) => `${s.label}: ${s.status}`).join("; ")}`);
  });
});
