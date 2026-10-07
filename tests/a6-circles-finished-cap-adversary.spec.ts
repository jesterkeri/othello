/**
 * A6 adversary on 5c308b7: listRank (app/src/lib/solana-circles.ts) puts "Forming, an invitation it has not joined" at
 * rank 3 and "finished, nothing left for it" at rank 4, and solanaCirclesOf reads only `all.slice(0, MAX_LISTED)`. A
 * finished circle this wallet joined and has already collected from is a circle it chose to be in, yet any stranger
 * outranks it: create_circle (programs/othello/src/instructions/create_circle.rs) names any wallet without consent and
 * takes any circle_id, and cancel_circle (programs/othello/src/instructions/lifecycle.rs handle_cancel_circle) lets the
 * creator cancel a Forming circle at will. So twelve invitations (rank 3), or twelve circles created and cancelled with
 * an id above the wallet's (rank 4, ties broken by id, highest first), push the wallet's own finished circle behind the
 * cap: it is off the board, out of the finished pile and its pop-up, and only counted in "Showing N of M".
 * Spec 2: "Nothing a third party can create (circles naming the wallet, any ids or amounts the program allows) may
 * hide, on the page or behind the server's cap of 12, a circle the wallet chose to be in".
 *
 * Fixtures are the shape tests/a6-circles-cap-adversary-r3.spec.ts uses for circlesOf, with the bitmaps the decoded
 * Circle account carries (programs/othello/src/state.rs). The card check runs the app's own card rule, so "finished,
 * shown in the pile" is the app's verdict, not this test's.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-finished-cap-adversary.spec.ts
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

const circle = (id: string, creator: Key, members: Key[], status: Record<string, unknown>, bits: Record<string, number> = {}) => ({
  address: `c${id}`,
  circle: {
    circleId: { toString: () => id },
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

describe("A6 adversary: strangers' circles push the wallet's own finished circle behind the Solana cap", () => {
  // this wallet's own completed circle: it created it, every seat joined and received, and it has collected (turn 0)
  const mine = circle("1", me, [me, key(2), key(3)], { completed: {} }, { joinedBitmap: 0b111, receivedBitmap: 0b111, withdrawnBitmap: 0b001 });

  it("the app's own card puts the wallet's finished circle in the finished pile", () => {
    const v = {
      side: "solana", address: "c1", href: "/circle/sol:c1", creator: me.toBase58(), n: 3, c: 50_000_000n,
      status: "Completed", round: 2, deadline: 2_000, graceSecs: 30, chainTime: 1_000, escrow: 0n, reserveTotal: 0n,
      money: USDC, collateral: "NFLXx", releasable: false,
      seats: [0, 1, 2].map((t) => ({ turn: t, wallet: [me, key(2), key(3)][t]!.toBase58(), joined: true, paid: true, received: true, defaulted: false, marked: false, withdrawn: t === 0 })),
      closeOut: { collected: 1, owedCount: 3, mine: { owed: true, collected: true, amount: null } },
    } as unknown as ListCircle;
    assert.equal(circleCard(v, me.toBase58()).group, "finished", "precondition: the wallet's circle belongs in the finished pile");
  });

  it("twelve strangers' invitations do not push the wallet's own finished circle behind the cap", () => {
    const invites = Array.from({ length: MAX_LISTED }, (_, k) => {
      const stranger = key(100 + k);
      return circle(String(100 + k), stranger, [stranger, me], { forming: {} }, { joinedBitmap: 0b01 });
    });
    const listed = circlesOf([mine, ...invites] as never, me.toBase58()).slice(0, MAX_LISTED).map((x) => x.address);
    assert.ok(listed.includes("c1"), `the wallet's own finished circle was capped out by strangers' invitations; listed: ${listed.join(", ")}`);
  });

  it("twelve circles a stranger created naming the wallet and cancelled do not push it behind the cap", () => {
    // the stranger picks circle ids above the wallet's; the wallet never joined, so the cancelled circles owe it nothing
    const cancelled = Array.from({ length: MAX_LISTED }, (_, k) => {
      const stranger = key(200 + k);
      return circle(String(18_000_000_000_000_000_000n + BigInt(k)), stranger, [stranger, me], { cancelled: {} }, { joinedBitmap: 0b01 });
    });
    const listed = circlesOf([mine, ...cancelled] as never, me.toBase58()).slice(0, MAX_LISTED).map((x) => x.address);
    assert.ok(listed.includes("c1"), `the wallet's own finished circle was capped out by a stranger's cancelled circles; listed: ${listed.join(", ")}`);
  });
});
