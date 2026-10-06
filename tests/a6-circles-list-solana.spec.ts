/**
 * A6: the shared circles list on Solana (Joshua 2026-10-06: one frontend for Robinhood and Solana, the same
 * capabilities on both). A Solana circle's read (LiveCircle) as the list's ListCircle (lib/to-list-solana.ts), its card
 * (lib/core/circle-card.ts), the wallet scan's filter (lib/solana-circles.ts circlesOf), the address check, and the
 * new routes in the route rules (lib/side-rules.ts, lib/chains.ts). Fixtures: the design's circle states
 * (app/src/fixtures/circles.ts), the same CircleView the Solana circle page renders.
 *
 *   npx mocha --import=tsx tests/a6-circles-list-solana.spec.ts
 */
import assert from "node:assert/strict";

import { CIRCLE_STATES, FIXTURE_NOW } from "../app/src/fixtures/circles.ts";
import { releaseBlock, type CircleView } from "../app/src/lib/circle.ts";
import { sideOf } from "../app/src/lib/chains.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";
import { fmtMoney, USDC } from "../app/src/lib/core/money.ts";
import { ringOf } from "../app/src/lib/core/ring.ts";
import { hrefFor } from "../app/src/lib/nav.ts";
import type { LiveCircle } from "../app/src/lib/live.ts";
import { pageNetwork } from "../app/src/lib/side-rules.ts";
import { parseAddress } from "../app/src/lib/sol-address.ts";
import { circlesOf, stockWord } from "../app/src/lib/solana-circles.ts";
import { solToList } from "../app/src/lib/to-list-solana.ts";
import { NFLXX_MIRROR } from "../app/src/lib/devnet.ts";

const ADDR = "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q";
const live = (view: CircleView, readAt = FIXTURE_NOW): LiveCircle => ({
  view,
  accounts: { circle: ADDR, usdcMint: "x", stockMint: "y" },
  split: { multiplier: 1e9, newMultiplier: 1e9, effectiveAt: 0 },
  pool: { discountBps: 0, usdc: 0 },
  readAt,
});
const seatWallet = (v: CircleView, turn: number) => v.members.find((m) => m.turn === turn)!.address;

describe("A6: the shared circles list on Solana", () => {
  describe("solToList", () => {
    it("maps the bitmaps to seats, in turn order, and names USDC and the stock", () => {
      const v = CIRCLE_STATES.active;
      const l = solToList(live(v), seatWallet(v, 4));
      assert.equal(l.side, "solana");
      assert.equal(l.href, `/circle/sol:${ADDR}`);
      assert.equal(l.money.unit, "USDC");
      assert.equal(l.collateral, "NFLXx");
      assert.equal(l.c, BigInt(v.contribution));
      assert.deepEqual(l.seats.map((s) => s.turn), [0, 1, 2, 3, 4]);
      assert.deepEqual(l.seats.map((s) => s.paid), [true, true, true, true, false]);
      assert.deepEqual(l.seats.map((s) => s.received), [true, false, false, false, false]);
      assert.ok(l.seats.every((s) => s.joined && !s.defaulted && !s.withdrawn && !s.marked));
      assert.equal(l.chainTime, FIXTURE_NOW);
    });

    it("can release only by the circle page's own rule (lib/circle.ts releaseBlock)", () => {
      const v = CIRCLE_STATES.active;
      assert.equal(solToList(live(v), null).releasable, false, "seat 5 has not paid");
      const allPaid = { ...v, paidBitmap: 0b11111 };
      assert.equal(releaseBlock(allPaid, FIXTURE_NOW), null);
      assert.equal(solToList(live(allPaid), null).releasable, true);
      const stale = { ...allPaid, feed: { ...allPaid.feed, updatedAt: FIXTURE_NOW - allPaid.maxPriceAge - 1 } };
      assert.equal(solToList(live(stale), null).releasable, false, "a stale price");
      const repricing = { ...allPaid, effectiveMultiplier: allPaid.effectiveMultiplier * 2 };
      assert.equal(solToList(live(repricing), null).releasable, false, "price and split disagree");
      const unpriced = { ...allPaid, feed: { ...allPaid.feed, sharePrice: 0 } };
      assert.equal(solToList(live(unpriced), null).releasable, false, "no price set");
      // a defaulted seat is covered from the escrow, when it holds that seat's share of the round (release_pot.rs)
      const covered = { ...v, defaultedBitmap: 0b10000, escrow: v.contribution };
      assert.equal(solToList(live(covered), null).releasable, true, "a defaulted seat is covered, not owed");
      assert.equal(releaseBlock({ ...covered, escrow: v.contribution - 1 }, FIXTURE_NOW), "escrow-short");
    });

    it("a finished circle: who collected, and this wallet's share named in words (no amount yet)", () => {
      const done = { ...CIRCLE_STATES.completed, withdrawnBitmap: 0b00011 };
      const l = solToList(live(done), seatWallet(done, 0));
      assert.deepEqual(l.closeOut, { collected: 2, owedCount: 5, mine: { owed: true, collected: true, amount: null } });
      const other = solToList(live(done), seatWallet(done, 3));
      assert.deepEqual(other.closeOut!.mine, { owed: true, collected: false, amount: null });
      // cancelled: only the seats that joined locked stock, so only they collect
      const cancelled = { ...CIRCLE_STATES.cancelled, joinedBitmap: 0b00011, withdrawnBitmap: 0b00001 };
      const c = solToList(live(cancelled), seatWallet(cancelled, 4));
      assert.deepEqual(c.closeOut, { collected: 1, owedCount: 2, mine: { owed: false, collected: false, amount: null } });
      assert.equal(solToList(live(CIRCLE_STATES.active), null).closeOut, null);
    });

    it("the ring reads the same seats, in USDC", () => {
      const l = solToList(live(CIRCLE_STATES.active), seatWallet(CIRCLE_STATES.active, 1));
      const ring = ringOf(l, seatWallet(CIRCLE_STATES.active, 1), l.chainTime, { fmt: (x) => fmtMoney(l.money, x), collateral: l.collateral });
      assert.equal(ring.receiving, 1);
      assert.equal(ring.seats[1]!.you, true);
      assert.equal(ring.seats[1]!.role, "receiving");
      assert.equal(ring.seats[4]!.payment, "due");
      assert.match(ring.caption, /Seat 2 receives 250 USDC$/);
    });
  });

  describe("cards", () => {
    it("pay in USDC, claim the pot, join with the stock, collect in words", () => {
      const v = CIRCLE_STATES.active;
      assert.equal(circleCard(solToList(live(v), seatWallet(v, 4)), seatWallet(v, 4)).headline, "Pay 50 USDC for round 2");
      const allPaid = { ...v, paidBitmap: 0b11111 };
      assert.equal(circleCard(solToList(live(allPaid), seatWallet(v, 1)), seatWallet(v, 1)).headline, "Claim your 250 USDC pot");
      assert.equal(circleCard(solToList(live(allPaid), seatWallet(v, 2)), seatWallet(v, 2)).group, "active");
      const forming = CIRCLE_STATES.forming;
      const notJoined = forming.members.find((m) => !((forming.joinedBitmap >> m.turn) & 1));
      if (notJoined) {
        assert.equal(circleCard(solToList(live(forming), notJoined.address), notJoined.address).headline, "Join and lock your NFLXx");
      }
      const done = CIRCLE_STATES.completed;
      const card = circleCard(solToList(live(done), seatWallet(done, 2)), seatWallet(done, 2));
      assert.equal(card.headline, "Collect your locked NFLXx and reserve share");
      assert.equal(card.group, "needs");
      assert.equal(card.detail, `5 members · ${fmtMoney(USDC, BigInt(done.contribution))} a round · 250 USDC pot`);
    });
  });

  describe("finding a wallet's circles", () => {
    // what the decoder hands back: keys that print as base58 (the root project has no @solana/web3.js of its own)
    type Key = { toBase58: () => string };
    const key = (n: number): Key => ({ toBase58: () => `Wallet${n}${"1".repeat(30)}` });
    const def: Key = { toBase58: () => "11111111111111111111111111111111" };
    const circle = (id: number, creator: Key, members: Key[], n = members.length, status: Record<string, unknown> = { active: {} }) =>
      ({ address: `c${id}`, circle: { circleId: { toString: () => String(id) }, creator, n, status, round: 0, joinedBitmap: 0, paidBitmap: 0, defaultedBitmap: 0, withdrawnBitmap: 0, members: [...members, ...Array(8 - members.length).fill(def)] } });

    it("keeps the circles the wallet created or holds a seat in", () => {
      const me = key(1);
      const all = [
        circle(1, key(2), [key(2), me]),
        circle(2, me, [key(3), key(4)]),
        circle(3, key(5), [key(5), key(6)]),
        circle(4, key(2), [key(2), key(3), me]),
      ];
      // c4 and c1: this wallet's seat is unpaid in the Active round (something to do); c2: created by it, no seat
      assert.deepEqual(circlesOf(all as never, me.toBase58()).map((x) => x.address), ["c4", "c1", "c2"]);
    });

    it("lists the circles the wallet has something to do in first, then the rest", () => {
      const me = key(1);
      const all = [
        circle(9, me, [me, key(2)], 2, { completed: {} }),
        circle(3, me, [me, key(2)], 2, { active: {} }),
        circle(8, me, [me, key(2)], 2, { cancelled: {} }),
        circle(2, me, [me, key(2)], 2, { forming: {} }),
      ];
      // c9 completed and c3 active both need this wallet (collect, pay), newest id first; c2 forming, created by it and
      // waiting for others; c8 cancelled before this wallet joined (nothing owed)
      assert.deepEqual(circlesOf(all as never, me.toBase58()).map((x) => x.address), ["c9", "c3", "c2", "c8"]);
    });

    it("ignores the unused seats past n (they hold the default key)", () => {
      const all = [circle(1, key(2), [key(2), key(3)], 2)];
      assert.deepEqual(circlesOf(all as never, def.toBase58()), []);
    });

    it("names the stock from its mint", () => {
      assert.equal(stockWord(NFLXX_MIRROR), "NFLXx mirror");
      assert.equal(stockWord("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"), "AAPLx");
      assert.equal(stockWord(ADDR), "stock");
    });
  });

  describe("addresses and routes", () => {
    it("accepts only a canonical base58 Solana address", () => {
      assert.equal(parseAddress(ADDR), ADDR);
      for (const bad of [null, "", "demo", "0x0000000000000000000000000000000000000000", ADDR.slice(0, 20), `${ADDR}11`, ADDR.replace("8", "0"), `${ADDR.slice(0, -1)}l`, " " + ADDR]) {
        assert.equal(parseAddress(bad), null, String(bad));
      }
    });

    it("Solana's Circles is the shared list; a Solana circle by address is a Solana page with seats 1 to 8", () => {
      assert.equal(hrefFor("Circles", "solana"), "/solana");
      assert.equal(pageNetwork("/solana"), "solana");
      assert.equal(pageNetwork(`/circle/sol:${ADDR}`), "solana");
      assert.equal(pageNetwork(`/circle/sol%3A${ADDR}`), "solana");
      assert.equal(pageNetwork("/circle/sol:nope"), null);
      assert.equal(pageNetwork(`/circle/sol:${ADDR}/position/8`), "solana");
      assert.equal(pageNetwork(`/circle/sol:${ADDR}/join/1`), "solana");
      assert.equal(pageNetwork(`/circle/sol:${ADDR}/join/9`), null);
      assert.equal(pageNetwork(`/circle/sol:${ADDR}/position/0`), null);
      assert.equal(sideOf(`/circle/sol:${ADDR}`), "solana");
      assert.equal(sideOf("/solana"), "solana");
    });
  });
});
