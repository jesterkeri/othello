/**
 * A6 adversary on 092c768: the Solana wallet scan reads only the first MAX_LISTED circles circlesOf returns
 * (app/src/lib/solana-circles.ts solanaCirclesOf: `all.slice(0, MAX_LISTED)`), and listRank puts every Active circle at
 * rank 0, whether or not this wallet has anything to do in it. An Active circle where this wallet has already paid this
 * round and it is not its turn to receive has nothing to do (lib/core/circle-card.ts: no Pay, no Claim, group
 * "active"), yet it outranks a finished circle this wallet still has to collect from (rank 1). Spec 2: "the cap must
 * never drop a circle in which the wallet has something to do (pay, claim, start, join it chose, collect) in favour of
 * one where it has nothing to do".
 *
 * Fixtures are the shape the existing circlesOf tests use (tests/a6-circles-cap-adversary.spec.ts), with the bitmaps
 * the decoded Circle account carries (programs/othello/src/state.rs). The card check runs this wallet's real card rule
 * on the same states, so "nothing to do" is the app's own verdict, not this test's.
 *
 *   npx mocha --import=tsx tests/a6-circles-cap-adversary-r3.spec.ts
 */
import assert from "node:assert/strict";

import { circleCard } from "../app/src/lib/core/circle-card.ts";
import type { ListCircle } from "../app/src/lib/core/circle-list.ts";
import { USDC } from "../app/src/lib/core/money.ts";
import { circlesOf, MAX_LISTED } from "../app/src/lib/solana-circles.ts";

type Key = { toBase58: () => string };
const key = (n: number): Key => ({ toBase58: () => `Wallet${n}${"1".repeat(30)}` });
const def: Key = { toBase58: () => "11111111111111111111111111111111" };
const me = key(1);

const circle = (id: number, creator: Key, members: Key[], status: Record<string, unknown>, bits: Record<string, number> = {}) => ({
  address: `c${id}`,
  circle: {
    circleId: { toString: () => String(id) },
    creator,
    n: members.length,
    status,
    round: 0,
    members: [...members, ...Array(8 - members.length).fill(def)],
    joinedBitmap: 0,
    paidBitmap: 0,
    withdrawnBitmap: 0,
    receivedBitmap: 0,
    defaultedBitmap: 0,
    ...bits,
  },
});

describe("A6 adversary r3: an Active circle with nothing to do outranks a Collect", () => {
  // this wallet holds seat 2 (turn 1); round 0; seats 0 and 1 have paid, seat 2 (key 3) has not, so nothing is
  // releasable and this wallet neither pays nor claims
  const idle = (id: number) => circle(id, key(2), [key(2), me, key(3)], { active: {} }, { joinedBitmap: 0b111, paidBitmap: 0b011 });
  // this wallet's own completed circle, its seat (turn 0) not yet withdrawn
  const owed = circle(1, me, [me, key(2), key(3)], { completed: {} }, { joinedBitmap: 0b111, receivedBitmap: 0b111, withdrawnBitmap: 0b110 });

  it("the app's own card says the Active circle has nothing for this wallet, and the finished one says Collect", () => {
    const seats = (paid: number, withdrawn: number) =>
      [0, 1, 2].map((t) => ({
        turn: t,
        wallet: [key(2), me, key(3)][t]!.toBase58(),
        joined: true,
        paid: (paid & (1 << t)) !== 0,
        received: false,
        defaulted: false,
        marked: false,
        withdrawn: (withdrawn & (1 << t)) !== 0,
      }));
    const base = { side: "solana", address: "x", href: "/x", creator: key(2).toBase58(), n: 3, c: 50_000_000n, round: 0, deadline: 2_000, graceSecs: 30, chainTime: 1_000, escrow: 0n, reserveTotal: 0n, money: USDC, collateral: "NFLXx", releasable: false, closeOut: null } as const;
    const active = { ...base, status: "Active", seats: seats(0b011, 0) } as unknown as ListCircle;
    const card = circleCard(active, me.toBase58());
    assert.notEqual(card.group, "needs", "precondition: the Active circle must have nothing for this wallet");
    const done = {
      ...base,
      status: "Completed",
      seats: [0, 1, 2].map((t) => ({ turn: t, wallet: [me, key(2), key(3)][t]!.toBase58(), joined: true, paid: true, received: true, defaulted: false, marked: false, withdrawn: t !== 0 })),
      closeOut: { collected: 2, owedCount: 3, mine: { owed: true, collected: false, amount: null } },
    } as unknown as ListCircle;
    assert.equal(circleCard(done, me.toBase58()).action, "Collect", "precondition: the finished circle must say Collect");
  });

  it("twelve Active circles with nothing to do do not push out the one this wallet must collect from", () => {
    const busy = Array.from({ length: MAX_LISTED }, (_, i) => idle(100 + i));
    const listed = circlesOf([owed, ...busy] as never, me.toBase58()).slice(0, MAX_LISTED).map((x) => x.address);
    assert.ok(listed.includes("c1"), `the circle this wallet has still to collect from was dropped; listed: ${listed.join(", ")}`);
  });
});
