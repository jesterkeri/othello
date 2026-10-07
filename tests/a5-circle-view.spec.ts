/**
 * A5 (Joshua, 2026-10-05): the Robinhood circle page draws the circle from live state and releases the pot truthfully.
 * lib/robinhood/circle-view.ts is pure; these cases pin the mapping from a circle read to the ring, the release button
 * and the six payout steps, against the contract's own rules (evm/src/OthelloCircle.sol releasePot: anyone may call;
 * seat i receives round i; RoundNotFunded while a seat is unsettled or the escrow cannot cover defaulted seats).
 *
 *   npx mocha --import=tsx tests/a5-circle-view.spec.ts
 */
import assert from "node:assert/strict";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { closeOutOf, currentPhase, releaseButton, seatFill, seatSize, releaseSteps, ringOf, seatList, type ReleaseContext } from "../app/src/lib/robinhood/circle-view.ts";

const U = 1_000_000n; // 1 USDG
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;

function seat(turn: number, over: Partial<RhSeat> = {}): RhSeat {
  return { turn, wallet: W(turn), collateral: 10n * U, g: U, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: 0, delinquentMarks: 0,
    roundsPaid: 0, joined: true, paid: false, received: false, defaulted: false, marked: false, withdrawn: false, ...over };
}
function circle(n: number, over: Partial<RhCircleView> = {}, seats?: RhSeat[]): RhCircleView {
  return { address: W(9), factory: W(8), creator: W(0), n, c: 2n * U, g: U, minStockCover: 10n * U, haircutBps: 1000, coverageBps: 10000, warnBps: 0,
    roundSecs: 86_400, graceSecs: 3_600, status: "Active", round: 0, deadline: 0, reserveTotal: 0n, reserveLosses: 0n, reserveAllocated: 0n,
    escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n, collateralReturned: 0n, depositsTotal: 0n, forfeitedTotal: 0n, nextGateShortBy: 0n,
    heldContributions: 0n, lastCoverageAt: 0, balance: 0n, surplus: 0n, seats: seats ?? Array.from({ length: n }, (_, i) => seat(i)), readAt: 0, chainTime: 0, block: 1, ...over };
}
const ok: ReleaseContext = { hasWallet: true, connected: true, onRobinhood: true, busy: false, me: W(7) };

describe("A5: the circle ring follows live state", () => {
  it("three seats: round 1, 2, 3 put seat 1, 2, 3 at the top, turning clockwise one seat per round", () => {
    for (const [round, rotation] of [[0, 0], [1, -120], [2, -240]] as const) {
      const ring = ringOf(circle(3, { round }));
      assert.equal(ring.receiving, round);
      assert.equal(ring.rotation, rotation, `round ${round + 1}`);
      // the receiving seat's angle plus the ring's turn is 0: it sits at the top
      assert.equal(ring.seats[round]!.angle + ring.rotation, 0);
      assert.equal(ring.seats[round]!.role, "receiving");
      assert.match(ring.caption, new RegExp(`^Round ${round + 1} of 3: Seat ${round + 1} receives 6 USDG`));
    }
  });

  it("3 to 8 seats: evenly spaced, each label Seat N, the receiver always at the top", () => {
    for (let n = 3; n <= 8; n++) {
      for (let round = 0; round < n; round++) {
        const ring = ringOf(circle(n, { round }));
        assert.deepEqual(ring.seats.map((x) => x.label), Array.from({ length: n }, (_, i) => `Seat ${i + 1}`));
        assert.deepEqual(ring.seats.map((x) => x.angle), Array.from({ length: n }, (_, i) => (i * 360) / n));
        assert.equal(Math.abs((ring.seats[round]!.angle + ring.rotation) % 360), 0, `n=${n} round=${round}`);
      }
    }
  });

  it("each seat's payment and role come from its flags: paid, covered (defaulted), late (marked), due; received earlier", () => {
    // seat 2 is settled in default and the escrow holds its 2 USDG payment, so it is truly covered
    const v = circle(4, { round: 2, escrow: 2n * U }, [seat(0, { received: true, paid: true }), seat(1, { received: true, defaulted: true }), seat(2, { marked: true }), seat(3)]);
    const ring = ringOf(v, W(3));
    assert.deepEqual(ring.seats.map((x) => [x.role, x.payment]), [["received", "paid"], ["received", "covered"], ["receiving", "late"], ["upcoming", "due"]]);
    assert.equal(ring.seats[3]!.you, true);
    assert.match(ring.seats[2]!.status, /receives this round, late/);
  });

  it("forming, completed and cancelled circles have no receiver and do not turn", () => {
    const forming = ringOf(circle(3, { status: "Forming" }, [seat(0), seat(1, { joined: false }), seat(2)]));
    assert.equal(forming.receiving, null);
    assert.equal(forming.rotation, 0);
    assert.deepEqual(forming.seats.map((x) => x.role), ["joined", "open", "joined"]);
    assert.equal(forming.caption, "2 of 3 seats joined");
    assert.equal(ringOf(circle(3, { status: "Completed", round: 3 })).caption, "All 3 rounds paid out");
    const cancelled = ringOf(circle(3, { status: "Cancelled" }, [seat(0), seat(1, { joined: false }), seat(2)]));
    assert.equal(cancelled.rotation, 0);
    assert.deepEqual(cancelled.seats.map((x) => x.role), ["joined", "open", "joined"]);
  });
});

describe("A5: the release button says who receives and why it cannot run", () => {
  const settled = () => circle(3, { round: 1 }, [seat(0, { paid: true, received: true }), seat(1, { paid: true }), seat(2, { paid: true })]);

  it("any member or visitor releases to the seat whose turn it is; the receiver claims", () => {
    assert.deepEqual(releaseButton(settled(), ok), { label: "Release 6 USDG to Seat 2", enabled: true, blocker: null, recipientTurn: 1, amount: 6n * U });
    assert.equal(releaseButton(settled(), { ...ok, me: W(1) })!.label, "Claim your 6 USDG pot");
  });

  it("names the exact blocker, in order: wallet, connection, network, busy, unpaid seats, escrow", () => {
    const v = settled();
    assert.equal(releaseButton(v, { ...ok, hasWallet: false })!.blocker, "Install MetaMask or another EVM wallet to release the pot.");
    assert.equal(releaseButton(v, { ...ok, connected: false })!.blocker, "Connect an EVM wallet to release the pot.");
    assert.equal(releaseButton(v, { ...ok, onRobinhood: false })!.blocker, "Switch your wallet to Robinhood Chain testnet to release the pot.");
    assert.equal(releaseButton(v, { ...ok, busy: true })!.blocker, "A transaction is already waiting for your wallet or for Robinhood Chain.");
    const unpaid = circle(3, { round: 0 }, [seat(0, { paid: true }), seat(1), seat(2)]);
    assert.equal(releaseButton(unpaid, ok)!.blocker, "Waiting for Seat 2 and Seat 3 to pay this round.");
    assert.equal(releaseButton(unpaid, ok)!.enabled, false);
    const short = circle(3, { round: 1, escrow: U }, [seat(0, { paid: true, received: true }), seat(1, { paid: true }), seat(2, { defaulted: true })]);
    assert.match(releaseButton(short, ok)!.blocker!, /^Missed payments need 1 USDG more cover/);
    assert.equal(releaseButton({ ...short, escrow: 2n * U }, ok)!.enabled, true);
  });

  it("a stale reserve shortfall does not block: the contract checks the reserve again on release", () => {
    assert.equal(releaseButton({ ...settled(), nextGateShortBy: 5n * U }, ok)!.enabled, true);
  });

  it("no button when the circle is not active", () => {
    for (const status of ["Forming", "Completed", "Cancelled"] as const) assert.equal(releaseButton(circle(3, { status }), ok), null);
  });

  it("seat lists read naturally", () => {
    assert.equal(seatList([1]), "Seat 2");
    assert.equal(seatList([0, 1, 3]), "Seat 1, Seat 2 and Seat 4");
  });
});

describe("A5: the payout steps follow the real transaction", () => {
  const settled = circle(3, { round: 1 }, [seat(0, { paid: true, received: true }), seat(1, { paid: true }), seat(2, { paid: true })]);
  const status = (steps: ReturnType<typeof releaseSteps>) => steps.map((x) => x.status);

  it("idle: payments and safety done, the rest to do; unpaid blocks payments", () => {
    assert.deepEqual(status(releaseSteps(settled, { kind: "idle" })), ["done", "done", "todo", "todo", "todo", "todo"]);
    const unpaid = circle(3, { round: 0 }, [seat(0, { paid: true }), seat(1), seat(2)]);
    const steps = releaseSteps(unpaid, { kind: "idle" });
    assert.equal(steps[0]!.status, "blocked");
    assert.equal(steps[0]!.detail, "1 of 3 paid; waiting for Seat 2 and Seat 3");
  });

  it("a stale reserve shortfall shows as the safety step's blocker until a release is tried", () => {
    assert.equal(releaseSteps({ ...settled, nextGateShortBy: 5n * U }, { kind: "idle" })[1]!.status, "blocked");
    // a release in the wallet has not been checked yet: the release itself checks the reserve again (A7 adversary on
    // 74ce48b: the step was ticked before the chain had checked anything)
    assert.equal(releaseSteps({ ...settled, nextGateShortBy: 5n * U }, { kind: "wallet" })[1]!.status, "todo");
  });

  it("wallet, then sent, then released; confirmed only after a read shows the recipient as received", () => {
    assert.deepEqual(status(releaseSteps(settled, { kind: "wallet" })), ["done", "todo", "now", "todo", "todo", "todo"]);
    assert.deepEqual(status(releaseSteps(settled, { kind: "sent", hash: "0xab" })), ["done", "now", "done", "now", "todo", "todo"]);
    const released = { kind: "released", hash: "0xab", round: 1, recipientTurn: 1, amount: 6n * U } as const;
    // the receipt is in, but the read still shows the old round: not confirmed yet
    assert.deepEqual(status(releaseSteps(settled, released)), ["done", "done", "done", "done", "done", "now"]);
    // a fresh read: round 2 is over, seat 2 received
    const after = circle(3, { round: 2 }, [seat(0, { received: true }), seat(1, { received: true }), seat(2)]);
    const steps = releaseSteps(after, released);
    assert.deepEqual(status(steps), ["done", "done", "done", "done", "done", "done"]);
    assert.equal(steps[5]!.detail, "Seat 2 received 6 USDG");
  });

  it("a refusal blocks the step it belongs to; nothing is marked paid", () => {
    const cover = releaseSteps(settled, { kind: "failed", message: "x", error: "CoverageTooLow", round: 1 });
    assert.equal(cover[1]!.status, "blocked");
    assert.deepEqual(status(cover).slice(4), ["todo", "todo"]);
    const rejected = releaseSteps(settled, { kind: "failed", message: "You rejected the request in your wallet.", error: "UserRejected", round: 1 });
    assert.equal(rejected[2]!.status, "blocked");
    assert.equal(rejected[2]!.detail, "You rejected the request in your wallet.");
    assert.deepEqual(status(rejected).slice(3), ["todo", "todo", "todo"]);
  });
});

describe("A5: a finished circle says how every member collects (Joshua, 2026-10-05)", () => {
  it("completed: each seat collects its own; who has collected; your exact locked USDG plus a reserve share", () => {
    // reserve left 3 USDG over three equal 1 USDG guarantees: each seat's reserve share is exactly 1 USDG (withdraw())
    const v = circle(3, { status: "Completed", round: 3, reserveTotal: 3n * U, depositsTotal: 3n * U }, [seat(0, { received: true, withdrawn: true }), seat(1, { received: true }), seat(2, { received: true, collateral: 4n * U })]);
    const c = closeOutOf(v, W(2))!;
    assert.equal(c.title, "All 3 rounds are paid out");
    assert.match(c.body, /Only the member's own wallet can collect it, and it does not expire\./);
    assert.deepEqual(c.seats.map((x) => [x.label, x.collected, x.owed, x.you]), [["Seat 1", true, true, false], ["Seat 2", false, true, false], ["Seat 3", false, true, true]]);
    assert.equal(c.collected, 1);
    assert.equal(c.owedCount, 3);
    assert.deepEqual(c.mine, { turn: 2, collected: false, owed: true, locked: 4n * U, pooled: U, total: 5n * U });
    assert.deepEqual(c.seats.map((x) => x.amount), [11n * U, 11n * U, 5n * U]);
    assert.match(ringOf(v, W(2)).seats[0]!.status, /collected their share/);
    assert.match(ringOf(v, W(2)).seats[1]!.status, /has not collected their share yet/);
  });

  it("cancelled: only joined seats are owed, the whole deposit back; a visitor has nothing to collect", () => {
    const v = circle(3, { status: "Cancelled" }, [seat(0, { topUps: U }), seat(1, { joined: false, collateral: 0n, g: 0n }), seat(2)]);
    const c = closeOutOf(v, W(0))!;
    assert.equal(c.title, "This circle was cancelled");
    assert.deepEqual(c.seats.map((x) => x.owed), [true, false, true]);
    assert.equal(c.owedCount, 2);
    assert.equal(c.mine!.total, 10n * U + U + U);
    assert.equal(closeOutOf(v, W(7))!.mine, null);
  });

  it("no close-out while forming or active", () => {
    assert.equal(closeOutOf(circle(3, { status: "Forming" }), W(0)), null);
    assert.equal(closeOutOf(circle(3), W(0)), null);
  });
});

describe("A5 fix pass on 05b8701: a refusal stays with its round; cover is shown only when it is real", () => {
  it("a failure from round 1 is not shown once the read is on round 2; it is shown while round 1 is current", () => {
    const failed = { kind: "failed", message: "The transaction failed on chain.", error: "Failed", round: 0 } as const;
    assert.deepEqual(currentPhase(failed, circle(3, { round: 1 })), { kind: "idle" });
    assert.deepEqual(currentPhase(failed, circle(3, { round: 0 })), failed);
    assert.deepEqual(currentPhase({ kind: "sent", hash: "0xab" }, circle(3, { round: 1 })), { kind: "sent", hash: "0xab" });
  });

  it("a defaulted seat is 'covered' only while the escrow covers its payment, else 'short'", () => {
    const seats = [seat(0, { paid: true, received: true }), seat(1, { paid: true }), seat(2, { defaulted: true })];
    assert.equal(ringOf(circle(3, { round: 1, escrow: 2n * U }, seats)).seats[2]!.payment, "covered");
    const short = ringOf(circle(3, { round: 1, escrow: U }, seats)).seats[2]!;
    assert.equal(short.payment, "short");
    assert.match(short.status, /cover short/);
  });
});

describe("A5 (Joshua, 2026-10-05): seat colours and sizes on the ring", () => {
  it("no seat, in a circle of 3 to 8, takes the hero's colour (the palette's accent), and neighbours differ", () => {
    for (let n = 3; n <= 8; n++) {
      const fills = Array.from({ length: n }, (_, t) => seatFill(t).fill);
      assert.ok(fills.every((f) => !f.includes("--acid")), `n=${n}: ${fills.join(", ")}`);
      for (let t = 0; t < n; t++) assert.notEqual(fills[t], fills[(t + 1) % n], `n=${n}: seats ${t + 1} and ${((t + 1) % n) + 1} share a colour`);
    }
    // the four other palette colours first, then white and black
    assert.deepEqual(Array.from({ length: 6 }, (_, t) => seatFill(t).fill), ["var(--teal)", "var(--sky)", "var(--cobalt)", "var(--clay)", "#FBF9F2", "#0B0B0B"]);
  });

  it("seats keep 20% up to four members and shrink about 10% for each member more", () => {
    assert.deepEqual([3, 4].map(seatSize), [20, 20]);
    const big = [5, 6, 7, 8].map(seatSize);
    assert.ok(big.every((x, i) => x < (i ? big[i - 1]! : 20)), big.join(", "));
    assert.ok(Math.abs(seatSize(5) - 18) < 1e-9 && seatSize(8) > 13 && seatSize(8) < 13.2, big.join(", "));
  });
});
