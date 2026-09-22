/**
 * T08: create_circle, the parameter ranges and the peak-guarantee check.
 *
 * The peak check is the one that matters. SPEC §3's table says what a circle's
 * reserve must cover in its worst round, and SPEC §5 puts that table on chain:
 * a circle whose guarantee cannot cover the worst round it will reach is not a
 * circle that fails later, it is one that should never have existed.
 *
 * Demo parameters, SPEC §5: n = 5, c = 50 USDC, coverage 130%, min cover 120.
 * Peak need is 150 USDC, so g = 30 passes exactly and g = 29 is refused.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  BN,
  call,
  circleAddress,
  fetchAccount,
  FIXTURE_MINTS,
  harness,
  initFeed,
  poolAddress,
  priceFeedAddress,
  splMintAccount,
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000;

/** SPEC §5 demo circle. */
const DEMO = {
  contribution: 50 * USDC,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13_000,
  warnBps: 11_000,
  guaranteePerMember: 30 * USDC,
  minStockCover: 120 * USDC,
  maxPriceAge: 691_200,
};

/** SPEC §5: "needs 140, 150, 30, 0 -> peak 150". */
const PEAK_NEED = 150 * USDC;

type CircleState = {
  creator: anchor.web3.PublicKey;
  n: number;
  members: anchor.web3.PublicKey[];
  status: Record<string, unknown>;
  contribution: { toNumber(): number };
  guaranteePerMember: { toNumber(): number };
  reserveTotal: { toNumber(): number };
  reserveAllocated: { toNumber(): number };
  joinedBitmap: number;
  roundDeadline: { toNumber(): number };
};

describe("T08 create_circle", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let members: anchor.web3.PublicKey[];
  let circleId = 0n;

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);

    // No USDC fixture exists, so write a plain SPL mint by hand.
    usdcMint = anchor.web3.Keypair.generate().publicKey;
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);

    // init_pool is T14, so write the pool the circle must read.
    const [pool, poolBump] = poolAddress(h.program, usdcMint, stockMint);
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", {
        authority: h.authority.publicKey,
        bump: poolBump,
        discountBps: 2000,
      }),
      h.program.programId,
    );

    await initFeed(h, stockMint);

    // The creator must be one of the members (ADR-003).
    members = [h.authority.publicKey, ...Array.from({ length: 4 }, () => anchor.web3.Keypair.generate().publicKey)];
  });

  function create(overrides: Partial<typeof DEMO> & { members?: anchor.web3.PublicKey[] } = {}) {
    const p = { ...DEMO, ...overrides };
    const id = circleId++;
    const circle = circleAddress(h.program, h.authority.publicKey, id);

    return call(h.program, "createCircle", [
      {
        circleId: new BN(Number(id)),
        contribution: new BN(p.contribution),
        roundSecs: new BN(p.roundSecs),
        graceSecs: new BN(p.graceSecs),
        haircutBps: p.haircutBps,
        coverageBps: p.coverageBps,
        warnBps: p.warnBps,
        guaranteePerMember: new BN(p.guaranteePerMember),
        minStockCover: new BN(p.minStockCover),
        maxPriceAge: new BN(p.maxPriceAge),
      },
      overrides.members ?? members,
    ])
      .accounts({
        creator: h.authority.publicKey,
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool: poolAddress(h.program, usdcMint, stockMint)[0],
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([h.authority])
      .rpc();
  }

  it("creates the demo circle in Forming, with everything zeroed", async () => {
    const id = circleId;
    await create();

    const state = await fetchAccount<CircleState>(
      h.program,
      "circle",
      circleAddress(h.program, h.authority.publicKey, id),
    );

    assert.equal(state.n, 5);
    assert.ok("forming" in state.status, "a new circle must be Forming");
    assert.equal(state.contribution.toNumber(), DEMO.contribution);
    assert.equal(state.creator.toBase58(), h.authority.publicKey.toBase58());
    assert.deepEqual(
      state.members.slice(0, 5).map((m) => m.toBase58()),
      members.map((m) => m.toBase58()),
      "turn order is the order the creator gave (ADR-003)",
    );

    // I2, I3 and I4 must hold from this instruction on.
    assert.equal(state.reserveTotal.toNumber(), 0);
    assert.equal(state.reserveAllocated.toNumber(), 0);
    assert.equal(state.joinedBitmap, 0);
    assert.equal(state.roundDeadline.toNumber(), 0, "activate sets the deadline, not create");
  });

  // T08's done-when, and SPEC §5's own worked example.
  it("refuses g = 29 and accepts g = 30, which is the peak exactly", async () => {
    assert.equal(
      await h.refusal(create({ guaranteePerMember: 29 * USDC })),
      "GuaranteeBelowPeakNeed",
      "5 x 29 = 145 is below the peak of 150",
    );

    await create({ guaranteePerMember: 30 * USDC });
  });

  it("the peak it enforces is SPEC's 150, not a rounder number", async () => {
    // One base unit either side of 5 x g = 150_000_000.
    const justUnder = PEAK_NEED / 5 - 1;

    assert.equal(await h.refusal(create({ guaranteePerMember: justUnder })), "GuaranteeBelowPeakNeed");
    await create({ guaranteePerMember: justUnder + 1 });
  });

  it("refuses every parameter range separately", async () => {
    const cases: [string, Partial<typeof DEMO>][] = [
      ["contribution of zero", { contribution: 0 }],
      ["guarantee of zero", { guaranteePerMember: 0 }],
      ["haircut of 100%", { haircutBps: 10_000 }],
      ["coverage below 100%", { coverageBps: 9_999 }],
      ["warn below 100%", { warnBps: 9_999 }],
      ["warn at or above coverage", { warnBps: 13_000 }],
      ["round shorter than 60s", { roundSecs: 59 }],
      ["grace shorter than 30s", { graceSecs: 29 }],
      ["max price age of zero", { maxPriceAge: 0 }],
      ["haircut below the pool's discount", { haircutBps: 1999, guaranteePerMember: 40 * USDC }],
    ];

    for (const [name, override] of cases) {
      assert.equal(await h.refusal(create(override)), "InvalidParams", name);
    }
  });

  it("refuses a member list that is the wrong size, or has a duplicate, or omits the creator", async () => {
    const stranger = () => anchor.web3.Keypair.generate().publicKey;

    assert.equal(
      await h.refusal(create({ members: [h.authority.publicKey, stranger()] })),
      "InvalidParams",
      "two members is below the minimum of three",
    );
    assert.equal(
      await h.refusal(
        create({ members: [h.authority.publicKey, ...Array.from({ length: 8 }, stranger)] }),
      ),
      "InvalidParams",
      "nine members is above the eight the bitmaps can hold",
    );
    assert.equal(
      await h.refusal(
        create({ members: [h.authority.publicKey, h.authority.publicKey, stranger()] }),
      ),
      "InvalidParams",
      "a wallet holding two seats would take two payouts",
    );
    assert.equal(
      await h.refusal(create({ members: [stranger(), stranger(), stranger()] })),
      "InvalidParams",
      "the creator must be in the circle it creates",
    );
  });

  // ADR-012, and the defence-in-depth half of it. init_price_feed already
  // refuses a mint outside the allowlist, so a counterfeit cannot get a feed
  // through the program at all. That makes create_circle's own allowlist check
  // unreachable by normal means, so the feed is written straight into the
  // harness to reach it. A guard that is never exercised is not a guard.
  it("refuses a byte-perfect counterfeit even when a feed for it already exists", async () => {
    const counterfeit = anchor.web3.Keypair.generate().publicKey;
    h.placeMint("NFLXx", counterfeit);

    const feed = priceFeedAddress(h.program, counterfeit);
    const [, feedBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("price"), counterfeit.toBuffer()],
      h.program.programId,
    );

    h.putAccount(
      feed,
      await h.program.coder.accounts.encode("priceFeed", {
        authority: h.authority.publicKey,
        stockMint: counterfeit,
        bump: feedBump,
        wrapperPrice: new BN(150 * USDC),
        sharePrice: new BN(150 * USDC),
        pricedForMultiplier: new BN(1_000_000_000),
        updatedAt: new BN(0),
      }),
      h.program.programId,
    );

    // The pool is keyed on both mints, so the counterfeit needs its own too.
    const [pool, poolBump] = poolAddress(h.program, usdcMint, counterfeit);
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", {
        authority: h.authority.publicKey,
        bump: poolBump,
        discountBps: 2000,
      }),
      h.program.programId,
    );

    const previous = stockMint;
    stockMint = counterfeit;

    try {
      assert.equal(await h.refusal(create()), "MintNotAllowed");
    } finally {
      stockMint = previous;
    }
  });
});
