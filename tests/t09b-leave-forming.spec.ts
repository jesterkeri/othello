/**
 * `leave_forming`: the G2 repair.
 *
 * Codex's gate 2 review found that a member who joined a Forming circle could
 * not recover their stock or guarantee if the creator did nothing. The design's
 * answer is that any joined member may leave at any time before activation, no
 * formation deadline and no override.
 *
 * The proof the decision asked for, in its own order: two members join a
 * THREE-seat circle, the third never joins, each exits independently and
 * receives exact stock and USDC; then rejoin, post-activation refusal, and
 * cancellation of the members who stay.
 *
 * Three seats rather than five on purpose. It is the smallest circle the SPEC
 * allows, so it is the case where one absent member is the largest possible
 * share of the problem, and it is the shape the finding was reported against.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  ASSOCIATED_TOKEN_PROGRAM,
  BEFORE_SPLIT,
  BN,
  CURRENT,
  FIXTURE_MINTS,
  ONE_X,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ataAddress,
  call,
  circleAddress,
  fetchAccount,
  harness,
  initFeed,
  poolAddress,
  priceFeedAddress,
  setPrices,
  splMintAccount,
  tokenAccount,
  tokenAmount,
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000;
/** MIN_MEMBERS. The smallest circle SPEC §5 allows. */
const N = 3;

/**
 * The demo circle's parameters, with n = 3. The peak for three seats at these
 * numbers is 10 USDC, so the 35 USDC guarantee (105 across three) passes the
 * create-time check with room to spare.
 *
 * It is 10 and not 0 because at k = 1 the member who has received still owes
 * TWO rounds, not one: ceil(50 x 2 x 1.3) = 130 against a 120 minimum. An
 * earlier version of this comment said 0 by counting one remaining round, and
 * the gate 2 re-review caught it. The figure is now pinned by
 * `peak_for_the_smallest_circle_is_ten` in create_circle.rs, so this comment
 * restates a tested number rather than asserting one.
 */
const PARAMS = {
  contribution: 50 * USDC,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13_000,
  warnBps: 11_000,
  guaranteePerMember: 35 * USDC,
  minStockCover: 120 * USDC,
  maxPriceAge: 691_200,
};

const LOCK_RAW = 110_000_000n;
const PRICE = 150 * USDC;
const START_STOCK = LOCK_RAW * 2n;
const START_USDC = BigInt(PARAMS.guaranteePerMember * 3);

type CircleState = {
  status: Record<string, unknown>;
  joinedBitmap: number;
  reserveTotal: { toNumber(): number };
  depositsTotal: { toNumber(): number };
  withdrawnUsdc: { toNumber(): number };
  withdrawnBitmap: number;
};

describe("leave_forming: a member's own way out of a stalled circle", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let creator: anchor.web3.Keypair;
  /** Seats 1 and 2 join. Seat 3 never does; that is the whole scenario. */
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;
  let circleId = 0n;

  const memberAddress = (w: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), w.toBuffer()],
      h.program.programId,
    )[0];

  const readCircle = () => fetchAccount<CircleState>(h.program, "circle", circle);

  const balance = async (
    owner: anchor.web3.PublicKey,
    mint: anchor.web3.PublicKey,
    prog: string,
  ) => {
    const info = await h.context.banksClient.getAccount(ataAddress(mint, owner, prog));
    return info ? tokenAmount(Buffer.from(info.data)) : 0n;
  };

  const join = (w: anchor.web3.Keypair) =>
    call(h.program, "joinAndLock", [new BN(LOCK_RAW.toString())])
      .accounts({
        wallet: w.publicKey,
        circle,
        member: memberAddress(w.publicKey),
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        memberStockAta: ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([w])
      .rpc();

  const leave = (w: anchor.web3.Keypair) =>
    call(h.program, "leaveForming", [])
      .accounts({
        wallet: w.publicKey,
        circle,
        member: memberAddress(w.publicKey),
        stockMint,
        usdcMint,
        memberStockAta: ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([w])
      .rpc();

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);

    usdcMint = anchor.web3.Keypair.generate().publicKey;
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);

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

    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, {
      wrapper: PRICE,
      share: PRICE,
      stamp: CURRENT,
      expected: ONE_X,
    });

    creator = h.fund(100 * anchor.web3.LAMPORTS_PER_SOL);
    wallets = [
      creator,
      ...Array.from({ length: N - 1 }, () => h.fund(100 * anchor.web3.LAMPORTS_PER_SOL)),
    ];

    const id = circleId++;
    circle = circleAddress(h.program, creator.publicKey, id);

    await call(h.program, "createCircle", [
      {
        circleId: new BN(Number(id)),
        contribution: new BN(PARAMS.contribution),
        roundSecs: new BN(PARAMS.roundSecs),
        graceSecs: new BN(PARAMS.graceSecs),
        haircutBps: PARAMS.haircutBps,
        coverageBps: PARAMS.coverageBps,
        warnBps: PARAMS.warnBps,
        guaranteePerMember: new BN(PARAMS.guaranteePerMember),
        minStockCover: new BN(PARAMS.minStockCover),
        maxPriceAge: new BN(PARAMS.maxPriceAge),
      },
      wallets.map((w) => w.publicKey),
    ])
      .accounts({
        creator: creator.publicKey,
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    for (const w of wallets) {
      const s = tokenAccount({
        mint: stockMint,
        owner: w.publicKey,
        amount: START_STOCK,
        tokenProgram: TOKEN_2022_PROGRAM,
      });
      h.putAccount(ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM), s.data, s.owner);

      const u = tokenAccount({
        mint: usdcMint,
        owner: w.publicKey,
        amount: START_USDC,
        tokenProgram: SPL_TOKEN_PROGRAM,
      });
      h.putAccount(ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM), u.data, u.owner);
    }
  });

  /** The reported scenario, exactly. */
  it("two of three join, the third never does, and each leaver gets everything back", async () => {
    await join(wallets[0]!);
    await join(wallets[1]!);

    const before = await readCircle();
    assert.equal(before.joinedBitmap, 0b011, "seats 1 and 2 in, seat 3 absent");
    assert.equal(before.reserveTotal.toNumber(), PARAMS.guaranteePerMember * 2);

    // activate cannot pass, and the creator is doing nothing about it.
    assert.equal(
      await h.refusal(
        call(h.program, "activate", [])
          .accounts({ creator: creator.publicKey, circle })
          .signers([creator])
          .rpc(),
      ),
      "NotAllJoined",
    );

    // Each leaves independently, in either order, without the creator.
    for (const [i, w] of [wallets[1]!, wallets[0]!].entries()) {
      await leave(w);

      assert.equal(
        await balance(w.publicKey, stockMint, TOKEN_2022_PROGRAM),
        START_STOCK,
        "every locked token back, to the base unit",
      );
      assert.equal(
        await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM),
        START_USDC,
        "and the whole guarantee",
      );

      const c = await readCircle();
      const left = i + 1;
      assert.equal(
        c.reserveTotal.toNumber(),
        PARAMS.guaranteePerMember * (2 - left),
        "reserve_total comes down with it",
      );
      assert.equal(
        c.depositsTotal.toNumber(),
        PARAMS.guaranteePerMember * (2 - left),
        "and so does deposits_total, which is now settled deposits and not ever-deposited",
      );
      assert.equal(c.withdrawnUsdc.toNumber(), 0, "an unwind is not a withdrawal");
      assert.equal(c.withdrawnBitmap, 0, "and marks no seat withdrawn");
    }

    assert.equal((await readCircle()).joinedBitmap, 0, "no seat is held any more");
    assert.equal(
      await balance(circle, stockMint, TOKEN_2022_PROGRAM),
      0n,
      "the stock vault is empty",
    );
    assert.equal(
      await balance(circle, usdcMint, SPL_TOKEN_PROGRAM),
      0n,
      "and so is the usdc vault: the circle holds nothing of anyone's",
    );
  });

  it("the Member account is closed, so the same wallet can rejoin cleanly", async () => {
    await join(wallets[0]!);
    await leave(wallets[0]!);

    assert.equal(
      await h.context.banksClient.getAccount(memberAddress(wallets[0]!.publicKey)),
      null,
      "the Member PDA is gone, not left as a husk",
    );

    // Rejoin. This is `init` on the same address, which only works because the
    // account was closed rather than zeroed in place.
    await join(wallets[0]!);

    const c = await readCircle();
    assert.equal(c.joinedBitmap, 0b001);
    assert.equal(c.reserveTotal.toNumber(), PARAMS.guaranteePerMember);
    assert.equal(
      c.depositsTotal.toNumber(),
      PARAMS.guaranteePerMember,
      "one join is counted once, not twice",
    );
  });

  it("refuses once the circle is Active, and once it is Cancelled", async () => {
    for (const w of wallets) await join(w);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    assert.equal(
      await h.refusal(leave(wallets[0]!)),
      "CircleNotForming",
      "after activation a member's collateral stands behind real obligations",
    );

    // And on a cancelled circle: withdraw is the settled path, not this.
    const id = circleId++;
    const other = circleAddress(h.program, creator.publicKey, id);
    await call(h.program, "createCircle", [
      {
        circleId: new BN(Number(id)),
        contribution: new BN(PARAMS.contribution),
        roundSecs: new BN(PARAMS.roundSecs),
        graceSecs: new BN(PARAMS.graceSecs),
        haircutBps: PARAMS.haircutBps,
        coverageBps: PARAMS.coverageBps,
        warnBps: PARAMS.warnBps,
        guaranteePerMember: new BN(PARAMS.guaranteePerMember),
        minStockCover: new BN(PARAMS.minStockCover),
        maxPriceAge: new BN(PARAMS.maxPriceAge),
      },
      wallets.map((w) => w.publicKey),
    ])
      .accounts({
        creator: creator.publicKey,
        circle: other,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool: poolAddress(h.program, usdcMint, stockMint)[0],
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const saved = circle;
    circle = other;
    try {
      await join(wallets[0]!);
      await call(h.program, "cancelCircle", [])
        .accounts({ creator: creator.publicKey, circle })
        .signers([creator])
        .rpc();
      assert.equal(await h.refusal(leave(wallets[0]!)), "CircleNotForming");
    } finally {
      circle = saved;
    }
  });

  it("a member who stays is still refunded by cancel and withdraw", async () => {
    await join(wallets[0]!);
    await join(wallets[1]!);

    // One leaves; the other stays and the creator eventually cancels.
    await leave(wallets[1]!);
    await call(h.program, "cancelCircle", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    await call(h.program, "withdraw", [])
      .accounts({
        wallet: wallets[0]!.publicKey,
        circle,
        member: memberAddress(wallets[0]!.publicKey),
        stockMint,
        usdcMint,
        memberStockAta: ataAddress(stockMint, wallets[0]!.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, wallets[0]!.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallets[0]!])
      .rpc();

    for (const w of [wallets[0]!, wallets[1]!]) {
      assert.equal(await balance(w.publicKey, stockMint, TOKEN_2022_PROGRAM), START_STOCK);
      assert.equal(await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM), START_USDC);
    }

    // I3 still reads, with the leaver's deposit removed from both sides rather
    // than counted as a loss.
    const c = await readCircle();
    assert.equal(
      Number(await balance(circle, usdcMint, SPL_TOKEN_PROGRAM)),
      c.reserveTotal.toNumber() - c.withdrawnUsdc.toNumber(),
      "I3 holds across an unwind and a cancellation together",
    );
  });

  it("refuses a wallet that never joined, and one that already left", async () => {
    await join(wallets[0]!);
    await leave(wallets[0]!);

    // Both cases hit the same wall: no Member account exists at that seed.
    await assert.rejects(leave(wallets[0]!), "a second leave has nothing to unwind");
    await assert.rejects(leave(wallets[1]!), "a wallet that never joined has nothing to unwind");
  });
});
