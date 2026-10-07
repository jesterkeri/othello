/**
 * The Robinhood portfolio's "Your circle" card (app/src/lib/robinhood/portfolio-circle.ts, Joshua 2026-10-06): which
 * of the wallet's circles it shows and what it says. Spec cases, written from the rule and the contract
 * (evm/src/OthelloCircle.sol: contribute() sets the seat's paid bit and adds one to roundsPaid; a seat that has
 * received the pot owes c x (n - roundsPaid), one that has not owes nothing):
 *   - only running (Active) circles with a seat for this wallet count;
 *   - one where the wallet must act (its seat joined, unpaid this round, not settled in default) comes first; among
 *     several, the earliest round deadline; on a tie, the newer circle;
 *   - with none to act on, the most recent running circle (the list arrives newest first);
 *   - with none running, nothing.
 *
 *   npx mocha --import=tsx tests/robinhood-portfolio-circle.spec.ts
 */
import assert from "node:assert/strict";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { circleCard, mustAct, pickCircle } from "../app/src/lib/robinhood/portfolio-circle.ts";

const U = 1_000_000n; // 1 USDG
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;
const ME = W(2);

function seat(turn: number, over: Partial<RhSeat> = {}): RhSeat {
  return { turn, wallet: W(turn), collateral: 10n * U, g: U, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: 0, delinquentMarks: 0,
    roundsPaid: 0, joined: true, paid: false, received: false, defaulted: false, marked: false, withdrawn: false, ...over };
}
/** A circle of n seats (seat i is W(i), so ME holds seat 3), at address W(addr). */
function circle(addr: number, n: number, over: Partial<RhCircleView> = {}, mine: Partial<RhSeat> = {}): RhCircleView {
  const seats = Array.from({ length: n }, (_, i) => seat(i, i === 2 ? mine : {}));
  return { address: W(addr), factory: W(8), creator: W(0), n, c: 2n * U, g: U, minStockCover: 10n * U, haircutBps: 1000, coverageBps: 10000, warnBps: 0,
    roundSecs: 86_400, graceSecs: 3_600, status: "Active", round: 0, deadline: 1_000, reserveTotal: 0n, reserveLosses: 0n, reserveAllocated: 0n,
    escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n, collateralReturned: 0n, depositsTotal: 0n, forfeitedTotal: 0n, nextGateShortBy: 0n,
    heldContributions: 0n, lastCoverageAt: 0, balance: 0n, surplus: 0n, seats, readAt: 0, chainTime: 0, block: 1, ...over };
}

describe("Robinhood portfolio: which circle the card shows", () => {
  it("nothing when no circle is running with this wallet in it", () => {
    assert.equal(pickCircle([], ME), null);
    const others = [circle(10, 3, { status: "Forming" }), circle(11, 3, { status: "Completed" }), circle(12, 3, { status: "Cancelled" })];
    assert.equal(pickCircle(others, ME), null, "forming, completed and cancelled circles are not running");
    assert.equal(pickCircle([circle(13, 2)], ME), null, "a two-seat circle has no seat for W(2)");
    assert.equal(pickCircle([circle(14, 3)], null), null, "no wallet, no seat");
  });

  it("a circle where the wallet must pay beats a newer one where it has paid", () => {
    const newer = circle(20, 3, {}, { paid: true });
    const older = circle(21, 3);
    assert.equal(pickCircle([newer, older], ME)?.address, older.address);
  });

  it("among circles where it must pay, the round that ends first; on a tie, the newer", () => {
    const late = circle(30, 3, { deadline: 9_000 });
    const soon = circle(31, 3, { deadline: 5_000 });
    assert.equal(pickCircle([late, soon], ME)?.address, soon.address);
    const a = circle(32, 3, { deadline: 5_000 });
    const b = circle(33, 3, { deadline: 5_000 });
    assert.equal(pickCircle([a, b], ME)?.address, a.address, "the first (newer) circle stays on a tie");
  });

  it("with nothing to act on, the most recent running circle, skipping finished ones", () => {
    const done = circle(40, 3, { status: "Completed" });
    const newest = circle(41, 3, {}, { paid: true });
    const older = circle(42, 3, {}, { defaulted: true });
    assert.equal(pickCircle([done, newest, older], ME)?.address, newest.address);
  });

  it("must act: joined, unpaid this round and not settled in default, in a running circle; any address casing", () => {
    assert.equal(mustAct(circle(50, 3), ME), true);
    const mixed = circle(51, 3, {}, { wallet: `0x${"aB".repeat(20)}` });
    assert.equal(mustAct(mixed, `0x${"Ab".repeat(20)}`), true, "the same address in another casing");
    assert.equal(mustAct(circle(50, 3), W(5)), false, "not a member");
    assert.equal(mustAct(circle(50, 3, {}, { paid: true }), ME), false);
    assert.equal(mustAct(circle(50, 3, {}, { defaulted: true }), ME), false);
    assert.equal(mustAct(circle(50, 3, {}, { joined: false }), ME), false);
    assert.equal(mustAct(circle(50, 3, { status: "Forming" }), ME), false);
  });
});

describe("Robinhood portfolio: what the card says", () => {
  it("round, seat, rounds bar and facts from the read, linking to the circle page", () => {
    const v = circle(60, 4, { round: 1 }, { collateral: 25n * U, g: 3n * U });
    v.seats[0] = seat(0, { received: true, paid: true, roundsPaid: 2 });
    const card = circleCard(v, ME)!;
    assert.equal(card.href, `/circle/rh:${W(60)}`);
    assert.equal(card.headline, "Round 2 of 4");
    assert.equal(card.sub, "Seat 3 · your pot is round 3");
    assert.equal(card.mustAct, true);
    assert.deepEqual(card.pips.map((p) => [p.mine, p.got]), [[false, true], [false, false], [true, false], [false, false]]);
    assert.equal(card.pips[0]!.title, "Round 1: Seat 1, paid out");
    assert.deepEqual(card.facts.map((f) => [f.label, f.value]), [
      ["Locked", "25 USDG"], ["Round 2", "due"], ["Guarantee", "3 USDG"], ["You owe", "0 USDG"],
    ]);
    assert.equal(circleCard(v, W(7)), null, "no card for a wallet without a seat");
  });

  it("you owe: nothing before the pot, c x (n - roundsPaid) after it (the contract's obligation)", () => {
    // seat 3 received in round 3 and has paid 3 of 5 rounds: 2 rounds x 2 USDG left
    const v = circle(70, 5, { round: 3 }, { received: true, roundsPaid: 3, paid: false });
    const card = circleCard(v, ME)!;
    assert.equal(card.sub, "Seat 3 · you have received your pot");
    assert.equal(card.facts.find((f) => f.label === "You owe")!.value, "4 USDG");
  });

  it("this round's state: paid, settled in default, late after grace or once marked, else due", () => {
    const state = (over: Partial<RhCircleView>, mine: Partial<RhSeat>) => circleCard(circle(80, 3, over, mine), ME)!.facts.find((f) => f.label === "Round 1")!.value;
    assert.equal(state({}, { paid: true }), "paid");
    assert.equal(state({}, { defaulted: true }), "settled in default");
    assert.equal(state({ deadline: 1_000, graceSecs: 3_600, chainTime: 4_600 }, {}), "due", "the last second of grace is not late");
    assert.equal(state({ deadline: 1_000, graceSecs: 3_600, chainTime: 4_601 }, {}), "late");
    assert.equal(state({}, { marked: true }), "late");
    assert.equal(circleCard(circle(81, 3, { round: 2 }), ME)!.sub, "Seat 3 · your pot is this round");
  });
});
