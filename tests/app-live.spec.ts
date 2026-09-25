/**
 * T18 / S2b: the app's chain readers, from the repo root.
 *
 * - scaledUi.ts against the REAL mainnet xStock mints (tests/fixtures, fetched
 *   at T00 with provenance): the same reader the real-xStocks panel uses.
 * - live.ts's decodeLive against accounts encoded by the deployed program's
 *   own IDL, in the demo circle's shape, before and after the split.
 * - app/src/lib/devnet.ts against the records the deploy wrote, so the app
 *   cannot drift from what is on devnet.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO } from "./artifacts.ts";
import { derive, stockCover } from "../app/src/lib/circle.ts";
import { DEMO_CIRCLE, LABELS, NFLXX_MIRROR, PROGRAM_ID, REAL_XSTOCKS, TEST_USDC } from "../app/src/lib/devnet.ts";
import { IDL, accountsCoder, decodeLive } from "../app/src/lib/live.ts";
import { multiplierAt, readMint, readScaledUi, toFixed1e9 } from "../app/src/lib/scaledUi.ts";

const { BN } = (anchor as unknown as { default: { BN: new (v: number | string) => unknown } }).default;
const json = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8"));
const fixture = (symbol: string) => json(`tests/fixtures/${symbol}.json`) as { address: string; dataBase64: string };

const USDC = 1_000_000;
const SPLIT_AT = 1_763_337_300;

describe("T18/S2b app readers", () => {
  describe("scaledUi.ts on the real mainnet xStocks", () => {
    it("reads NFLXx's real 10-for-1: multiplier 1, new multiplier 10 at 1763337300", () => {
      const s = readScaledUi(Buffer.from(fixture("NFLXx").dataBase64, "base64"));
      assert.deepEqual(s, { multiplier: 1, newMultiplier: 10, effectiveAt: SPLIT_AT });
      assert.equal(multiplierAt(s!, SPLIT_AT - 1), 1);
      assert.equal(multiplierAt(s!, SPLIT_AT), 10);
    });

    it("finds the extension on all four real mints, among their other extensions", () => {
      for (const x of REAL_XSTOCKS) {
        const data = Buffer.from(fixture(x.symbol).dataBase64, "base64");
        assert.equal(fixture(x.symbol).address, x.address, `${x.symbol}: app address matches the fixture's`);
        const m = readMint(data);
        assert.ok(m.scaledUi, `${x.symbol} has ScaledUiAmountConfig`);
        assert.equal(m.decimals, 8);
      }
    });

    // SPEC I5's vectors and gate 1's T02 case: the app must land on the
    // program's integer (valuation.rs decode_multiplier_fixed), not a neighbour.
    it("fixes multipliers exactly as the program does: floor(m x 1e9), from the bits", () => {
      const aapl = readScaledUi(Buffer.from(fixture("AAPLx").dataBase64, "base64"))!;
      assert.equal(toFixed1e9(1.0026642075893797), 1_002_664_207);
      assert.equal(toFixed1e9(1.0032690125398187), 1_003_269_012);
      assert.equal(toFixed1e9(1.0000003), 1_000_000_299);
      assert.equal(toFixed1e9(1), 1_000_000_000);
      assert.equal(toFixed1e9(10), 10_000_000_000);
      assert.ok([aapl.multiplier, aapl.newMultiplier].every((m) => Number.isInteger(toFixed1e9(m))));
      for (const bad of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5e-324, 1e-10]) {
        assert.throws(() => toFixed1e9(bad), /cannot be a live multiplier/, `accepted ${bad}`);
      }
    });

    it("returns null, never a made-up multiplier, for a mint without the extension", () => {
      assert.equal(readScaledUi(Buffer.alloc(82)), null, "a classic SPL mint");
      const noExt = Buffer.alloc(170);
      noExt[165] = 1; // account type Mint, then an Uninitialized TLV entry
      assert.equal(readScaledUi(noExt), null);
      const notAMint = Buffer.from(fixture("NFLXx").dataBase64, "base64");
      notAMint[165] = 2; // account type Account, not Mint
      assert.equal(readScaledUi(notAMint), null);
    });
  });

  describe("live.ts decodeLive, demo circle shape", () => {
    const coder = accountsCoder();
    const pk = () => anchor.web3.Keypair.generate().publicKey;
    const wallets = Array.from({ length: 5 }, pk);
    const circleKey = pk();

    const circle = (over: Record<string, unknown> = {}) =>
      coder.encode("circle", {
        creator: wallets[0], circleId: new BN(0), bump: 255,
        stockMint: pk(), usdcMint: pk(), priceFeed: pk(), pool: pk(),
        n: 5, members: [...wallets, ...Array.from({ length: 3 }, () => anchor.web3.PublicKey.default)],
        contribution: new BN(50 * USDC), roundSecs: new BN(120), graceSecs: new BN(60),
        haircutBps: 2000, coverageBps: 13000, warnBps: 11000,
        guaranteePerMember: new BN(35 * USDC), minStockCover: new BN(120 * USDC), maxPriceAge: new BN(691_200),
        status: { active: {} }, round: 0, roundDeadline: new BN(1_000),
        paidBitmap: 0b00010, joinedBitmap: 0b11111, withdrawnBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0,
        reserveTotal: new BN(175 * USDC), reserveLosses: new BN(0), reserveAllocated: new BN(0),
        escrow: new BN(0), escrowDeficit: new BN(0), withdrawnUsdc: new BN(0), depositsTotal: new BN(175 * USDC),
        forfeitedTotal: new BN(0), nextGateShortBy: new BN(0), heldContributions: new BN(50 * USDC), lastCoverageAt: new BN(900),
        ...over,
      });
    const member = (turn: number, wallet = wallets[turn]!) =>
      coder.encode("member", {
        circle: circleKey, wallet, turn, bump: 255, stockRaw: new BN(110_000_000), guarantee: new BN(35 * USDC),
        topUps: new BN(0), forfeited: new BN(0), roundsPaid: turn === 1 ? 1 : 0, allocated: new BN(0), lastCoverageBps: 0,
      });
    const feed = (share: number, priced: string) =>
      coder.encode("priceFeed", {
        authority: pk(), stockMint: pk(), bump: 255, wrapperPrice: new BN(150 * USDC), sharePrice: new BN(share * USDC),
        pricedForMultiplier: new BN(priced), updatedAt: new BN(900),
      });
    /** A Token-2022 mint with only ScaledUiAmountConfig, the devnet mirror's exact layout (226 bytes). */
    const mint = (multiplier: number, newMultiplier: number, effectiveAt: number) => {
      const b = Buffer.alloc(226);
      b[44] = 8;
      b[45] = 1;
      b[165] = 1;
      b.writeUInt16LE(25, 166);
      b.writeUInt16LE(56, 168);
      b.writeDoubleLE(multiplier, 170 + 32);
      b.writeBigInt64LE(BigInt(effectiveAt), 170 + 40);
      b.writeDoubleLE(newMultiplier, 170 + 48);
      return b;
    };

    it("maps every field the screen reads, and H = 132 as SPEC.md:137 says", async () => {
      const v = decodeLive(
        { circle: await circle(), feed: await feed(150, "1000000000"), mint: mint(1, 1, 0), members: await Promise.all(wallets.map((_, i) => member(i))) },
        "NFLXx mirror",
        1_000,
      );
      assert.equal(v.status, "Active");
      assert.equal(v.n, 5);
      assert.deepEqual(v.members.map((m) => m.address), wallets.map(String));
      assert.equal(v.members[1]!.roundsPaid, 1);
      assert.equal(v.contribution, 50 * USDC);
      assert.equal(v.reserveTotal, 175 * USDC);
      assert.equal(v.effectiveMultiplier, 1_000_000_000);
      assert.equal(stockCover(v.members[0]!, v), 132 * USDC);
      assert.equal(derive(v, 1_000).repricing, false);
    });

    it("shows the split the way the program sees it: Repricing until the effective time, then H is still 132", async () => {
      const accounts = {
        circle: await circle(),
        feed: await feed(15, "10000000000"),
        mint: mint(1, 10, 2_000),
        members: await Promise.all(wallets.map((_, i) => member(i))),
      };
      const raw = (now: number) => decodeLive(accounts, "NFLXx mirror", now);
      const before = raw(1_999);
      assert.equal(derive(before, 1_999).repricing, true, "prices stamped for 10x while the mint is still 1x");
      const after = raw(2_000);
      assert.equal(derive(after, 2_000).repricing, false);
      assert.equal(after.effectiveMultiplier, 10_000_000_000);
      assert.equal(stockCover(after.members[0]!, after), 132 * USDC, "value preserved across the split");
    });

    it("lists a Forming circle's unjoined seats, and refuses a joined seat with no Member account", async () => {
      const forming = await circle({ status: { forming: {} }, joinedBitmap: 0b00011 });
      const v = decodeLive(
        { circle: forming, feed: await feed(150, "1000000000"), mint: mint(1, 1, 0), members: [await member(0), await member(1), null, null, null] },
        "NFLXx mirror",
        1_000,
      );
      assert.equal(v.status, "Forming");
      assert.equal(v.members.length, 5);
      assert.equal(v.members[4]!.lockedRaw, 0);
      const oneMissing = { circle: forming, feed: await feed(150, "1000000000"), mint: mint(1, 1, 0), members: [await member(0), null, null, null, null] };
      assert.throws(
        () => decodeLive(oneMissing, "x", 1_000),
        /Seat 2 has joined but its Member account is missing/,
      );
    });

    it("refuses a Member account that belongs to another seat", async () => {
      const swapped = await Promise.all(wallets.map((_, i) => member(i)));
      swapped[2] = await member(3);
      const accounts = { circle: await circle(), feed: await feed(150, "1000000000"), mint: mint(1, 1, 0), members: swapped };
      assert.throws(
        () => decodeLive(accounts, "x", 1_000),
        /seat 3 does not match/,
      );
    });
  });

  describe("devnet.ts against the deploy's own records", () => {
    it("matches ops/demo-circle.json, ops/devnet-mints.json, the IDL and declare_id", () => {
      const demo = json("ops/demo-circle.json");
      const mints = json("ops/devnet-mints.json");
      assert.equal(PROGRAM_ID, demo.program);
      assert.equal(PROGRAM_ID, IDL.address);
      assert.match(readFileSync(resolve(REPO, "programs/othello/src/lib.rs"), "utf8"), new RegExp(`declare_id!\\("${PROGRAM_ID}"\\)`));
      assert.equal(DEMO_CIRCLE, demo.circle);
      assert.equal(NFLXX_MIRROR, demo.stockMint);
      assert.equal(NFLXX_MIRROR, mints.nflxxMirror);
      assert.equal(TEST_USDC, demo.usdcMint);
      assert.equal(TEST_USDC, mints.testUsdc);
      assert.deepEqual(LABELS, mints.labels);
    });

    it("lists exactly the four mainnet mints in allowlist.rs", () => {
      const rust = readFileSync(resolve(REPO, "programs/othello/src/allowlist.rs"), "utf8");
      const declared = [...rust.matchAll(/^pub const [A-Z]+: Pubkey = Pubkey::from_str_const\("([^"]+)"\)/gm)].map((m) => m[1]);
      assert.deepEqual([...declared].sort(), REAL_XSTOCKS.map((x) => x.address).sort());
    });
  });
});
