/**
 * A6 adversary on 92b2ab7: the Solana wallet scan reads only the first MAX_LISTED circles circlesOf returns
 * (app/src/lib/solana-circles.ts solanaCirclesOf: `all.slice(0, MAX_LISTED)`), and circlesOf claims its order means
 * "a cap never drops a circle the wallet may have to act in". Two inputs where it does:
 *
 * 1. A stranger names this wallet in Forming circles. create_circle takes the member list from the creator with no
 *    signature from the members (programs/othello/src/instructions/create_circle.rs: "the creator names the members,
 *    and must be one"), and picks circle_id freely (any u64 in the PDA seeds). Twelve such circles with ids above the
 *    wallet's real Active circle push that circle, where this wallet's seat is unpaid and the card must say Pay
 *    (spec 1), out of the list and out of the Needs-you count.
 * 2. Thirteen finished circles, the lowest id still owed to this wallet (withdrawn bit clear): the cap shows twelve
 *    already collected and drops the one Collect.
 *
 * Fixtures are the shape the existing circlesOf tests use (tests/a6-circles-list-solana.spec.ts), with the bitmaps the
 * decoded Circle account carries (programs/othello/src/state.rs).
 *
 *   npx mocha --import=tsx tests/a6-circles-cap-adversary.spec.ts
 */
import assert from "node:assert/strict";

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
    members: [...members, ...Array(8 - members.length).fill(def)],
    joinedBitmap: 0,
    paidBitmap: 0,
    withdrawnBitmap: 0,
    receivedBitmap: 0,
    defaultedBitmap: 0,
    ...bits,
  },
});

describe("A6 adversary: the Solana list's cap drops a circle this wallet must act in", () => {
  it("strangers' Forming circles naming this wallet do not push out its Active circle where it owes a payment", () => {
    // this wallet's real circle: Active, round 1, seat 2 (this wallet) unpaid
    const real = circle(1, key(2), [key(2), me, key(3)], { active: {} }, { joinedBitmap: 0b111, paidBitmap: 0b101, receivedBitmap: 0b001 });
    // spam: a stranger (key 9) creates circles listing this wallet, ids chosen above the real one
    const spam = Array.from({ length: MAX_LISTED }, (_, i) => circle(1000 + i, key(9), [key(9), me, key(8)], { forming: {} }, { joinedBitmap: 0b001 }));
    const listed = circlesOf([real, ...spam] as never, me.toBase58()).slice(0, MAX_LISTED).map((x) => x.address);
    assert.ok(listed.includes("c1"), `the Active circle this wallet must pay in was dropped; listed: ${listed.join(", ")}`);
  });

  it("finished circles already collected do not push out the one this wallet has still to collect", () => {
    const owed = circle(1, me, [me, key(2), key(3)], { completed: {} }, { joinedBitmap: 0b111, receivedBitmap: 0b111, withdrawnBitmap: 0b110 });
    const collected = Array.from({ length: MAX_LISTED }, (_, i) =>
      circle(100 + i, me, [me, key(2), key(3)], { completed: {} }, { joinedBitmap: 0b111, receivedBitmap: 0b111, withdrawnBitmap: 0b111 }));
    const listed = circlesOf([owed, ...collected] as never, me.toBase58()).slice(0, MAX_LISTED).map((x) => x.address);
    assert.ok(listed.includes("c1"), `the circle this wallet has still to collect from was dropped; listed: ${listed.join(", ")}`);
  });
});
