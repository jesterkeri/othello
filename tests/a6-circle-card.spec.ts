/**
 * A6 (Joshua, 2026-10-06): the "Your Robinhood circles" list separates what needs you, what is active and what is
 * finished, so a finished circle is plain to see, and each card names the one next step for this wallet.
 * lib/robinhood/circle-card.ts is pure; these cases pin every group and headline against the contract's rules
 * (evm/src/OthelloCircle.sol: activate by the creator once all have joined; seat i receives round i; releasePot once
 * every seat has paid or been settled; withdraw() pays each member their own seat).
 *
 *   npx mocha --import=tsx tests/a6-circle-card.spec.ts
 */
import assert from "node:assert/strict";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { circleCard, groupCards } from "../app/src/lib/robinhood/circle-card.ts";

const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;
function seat(turn: number, over: Partial<RhSeat> = {}): RhSeat {
  return { turn, wallet: W(turn), collateral: 20n * U, g: 5n * U, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: 0, delinquentMarks: 0,
    roundsPaid: 0, joined: true, paid: false, received: false, defaulted: false, marked: false, withdrawn: false, ...over };
}
function circle(over: Partial<RhCircleView> = {}, seats?: RhSeat[]): RhCircleView {
  return { address: W(9), factory: W(8), creator: W(0), n: 3, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000, coverageBps: 13000,
    warnBps: 11000, roundSecs: 86_400, graceSecs: 3_600, status: "Active", round: 1, deadline: 1_000_000, reserveTotal: 15n * U, reserveLosses: 0n,
    reserveAllocated: 0n, escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n, collateralReturned: 0n, depositsTotal: 15n * U, forfeitedTotal: 0n,
    nextGateShortBy: 0n, heldContributions: 0n, lastCoverageAt: 0, balance: 0n, surplus: 0n,
    seats: seats ?? [seat(0, { received: true }), seat(1), seat(2)], readAt: 0, chainTime: 999_000, block: 1, ...over };
}

describe("A6: a circle card's group and next step", () => {
  it("forming, not joined yet: needs you, Join", () => {
    const c = circleCard(circle({ status: "Forming", round: 0 }, [seat(0), seat(1, { joined: false }), seat(2, { joined: false })]), W(1));
    assert.deepEqual([c.group, c.headline, c.action], ["needs", "Join and lock your USDG", "Join"]);
  });

  it("forming, joined, others missing: active, says how many are still to join", () => {
    const c = circleCard(circle({ status: "Forming", round: 0 }, [seat(0), seat(1), seat(2, { joined: false })]), W(1));
    assert.deepEqual([c.group, c.band, c.headline], ["active", "Forming", "Waiting for 1 of 3 members to join"]);
  });

  it("forming, everyone joined: the creator is asked to start; another member waits for the creator", () => {
    const full = circle({ status: "Forming", round: 0 });
    assert.deepEqual([circleCard(full, W(0)).group, circleCard(full, W(0)).headline], ["needs", "Everyone has joined: start the circle"]);
    assert.deepEqual([circleCard(full, W(1)).group, circleCard(full, W(1)).headline],
      ["active", "Everyone has joined: waiting for the creator to start"]);
  });

  it("active, this wallet has not paid this round: needs you, Pay 10 USDG for round 2", () => {
    const c = circleCard(circle(), W(2));
    assert.deepEqual([c.group, c.headline, c.action], ["needs", "Pay 10 USDG for round 2", "Pay"]);
  });

  it("active, unpaid after deadline + grace by chain time: the headline says late", () => {
    const c = circleCard(circle({ chainTime: 1_000_000 + 3_600 + 1 }), W(2));
    assert.equal(c.headline, "Pay 10 USDG for round 2: late");
    assert.equal(circleCard(circle({ chainTime: 1_000_000 + 3_600 }), W(2)).headline, "Pay 10 USDG for round 2", "at grace end exactly it is not late");
  });

  it("active, a defaulted seat is not asked to pay (it was settled in default)", () => {
    const v = circle({}, [seat(0, { received: true, defaulted: true }), seat(1, { paid: true }), seat(2, { paid: true })]);
    assert.notEqual(circleCard(v, W(0)).group, "needs");
  });

  it("active, everyone paid and it is this wallet's turn: needs you, Claim your 30 USDG pot", () => {
    const v = circle({}, [seat(0, { received: true, paid: true }), seat(1, { paid: true }), seat(2, { paid: true })]);
    const c = circleCard(v, W(1));
    assert.deepEqual([c.group, c.headline, c.action, c.yourTurn], ["needs", "Claim your 30 USDG pot", "Claim", "You receive the pot this round"]);
  });

  it("active, this wallet's turn but someone has not paid: not a claim, it waits like everyone else", () => {
    const v = circle({}, [seat(0, { received: true, paid: true }), seat(1, { paid: true }), seat(2)]);
    const c = circleCard(v, W(1));
    assert.deepEqual([c.group, c.headline], ["active", "Round 2 of 3: Seat 2 receives 30 USDG"]);
  });

  it("active, a defaulted unpaid seat without enough escrow cover: no claim (releasePot would refuse)", () => {
    const v = circle({ escrow: 0n }, [seat(0, { received: true, defaulted: true }), seat(1, { paid: true }), seat(2, { paid: true })]);
    assert.notEqual(circleCard(v, W(1)).headline, "Claim your 30 USDG pot");
  });

  it("active, paid and not this wallet's turn: active, names the round and who receives", () => {
    const v = circle({}, [seat(0, { received: true, paid: true }), seat(1), seat(2, { paid: true })]);
    const c = circleCard(v, W(2));
    assert.deepEqual([c.group, c.band, c.headline, c.yourTurn], ["active", "Active", "Round 2 of 3: Seat 2 receives 30 USDG", "You receive the pot in round 3"]);
    assert.equal(circleCard(v, W(0)).yourTurn, "You received the pot in round 1", "a past turn is in the past tense");
  });

  it("completed, this wallet has not collected: needs you, Collect your exact withdraw() amount", () => {
    // withdraw: collateral 20 + pooled (15 reserve * 5 / 15 deposits) = 25 USDG
    const v = circle({ status: "Completed", round: 2 }, [seat(0, { received: true, withdrawn: true }), seat(1, { received: true }), seat(2, { received: true, withdrawn: true })]);
    const c = circleCard(v, W(1));
    assert.deepEqual([c.group, c.headline, c.action, c.yourTurn], ["needs", "Collect your 25 USDG", "Collect", "You received the pot in round 2"]);
  });

  it("completed, this wallet has collected: finished, says what it collected and how many have", () => {
    const v = circle({ status: "Completed", round: 2 }, [seat(0, { received: true, withdrawn: true }), seat(1, { received: true, withdrawn: true }), seat(2, { received: true })]);
    const c = circleCard(v, W(1));
    assert.deepEqual([c.group, c.band, c.headline], ["finished", "Finished", "You collected 25 USDG · 2 of 3 collected"]);
  });

  it("cancelled: a joined member who has not collected needs to; an unjoined one is finished with nothing owed", () => {
    const v = circle({ status: "Cancelled", round: 0 }, [seat(0), seat(1, { joined: false }), seat(2)]);
    const joined = circleCard(v, W(0));
    assert.deepEqual([joined.group, joined.headline], ["needs", "Collect your 25 USDG"]);
    const unjoined = circleCard(v, W(1));
    assert.deepEqual([unjoined.group, unjoined.band, unjoined.headline], ["finished", "Cancelled", "Cancelled · 0 of 2 collected"]);
    assert.equal(unjoined.yourTurn, "Cancelled before it started");
  });

  it("groups come in page order (needs you, active, finished) and empty groups are left out", () => {
    const items = [
      { id: "a", card: circleCard(circle({ status: "Completed", round: 2 }, [seat(0, { withdrawn: true }), seat(1, { withdrawn: true }), seat(2, { withdrawn: true })]), W(1)) },
      { id: "b", card: circleCard(circle(), W(2)) },
    ];
    assert.deepEqual(groupCards(items).map((g) => [g.title, g.items.map((x) => x.id)]), [["Needs you", ["b"]], ["Finished", ["a"]]]);
  });
});
