/**
 * T10: contribute and release_pot, against the demo circle.
 *
 * The done-when is I1, I6 and I10 green, SPEC's table reproduced, and no Paused
 * after a healthy payout (the half of I18 that belongs to gate 2).
 *
 * The table is reproduced in Rust, in `gate.rs`'s own unit tests, because that
 * is where the arithmetic lives and it can be asserted there without a
 * validator. What these tests prove is the other half: that the instruction
 * actually uses it, and that the money and the bitmaps agree afterwards.
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

/** SPEC.md:134. */
const DEMO = {
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

const N = 5;
const POT = DEMO.contribution * N;
const LOCK_RAW = 110_000_000n;
const PRICE = 150 * USDC;

type CircleState = {
  status: Record<string, unknown>;
  round: number;
  paidBitmap: number;
  receivedBitmap: number;
  reserveTotal: { toNumber(): number };
  reserveAllocated: { toNumber(): number };
  heldContributions: { toNumber(): number };
  nextGateShortBy: { toNumber(): number };
  roundDeadline: { toNumber(): number };
};

type MemberState = {
  turn: number;
  roundsPaid: number;
  allocated: { toNumber(): number };
  lastCoverageBps: number;
  stockRaw: { toString(): string };
};

describe("T10 contribute and release_pot", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let creator: anchor.web3.Keypair;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;
  let circleId = 0n;

  const memberAddress = (wallet: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), wallet.toBuffer()],
      h.program.programId,
    )[0];

  const readCircle = () => fetchAccount<CircleState>(h.program, "circle", circle);
  const readMember = (w: anchor.web3.PublicKey) =>
    fetchAccount<MemberState>(h.program, "member", memberAddress(w));

  const usdcOf = async (owner: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(
      ataAddress(usdcMint, owner, SPL_TOKEN_PROGRAM),
    );
    return info ? tokenAmount(Buffer.from(info.data)) : null;
  };

  function fundWallet(wallet: anchor.web3.PublicKey, stock: bigint, usdc: bigint) {
    const s = tokenAccount({
      mint: stockMint,
      owner: wallet,
      amount: stock,
      tokenProgram: TOKEN_2022_PROGRAM,
    });
    h.putAccount(ataAddress(stockMint, wallet, TOKEN_2022_PROGRAM), s.data, s.owner);

    const u = tokenAccount({
      mint: usdcMint,
      owner: wallet,
      amount: usdc,
      tokenProgram: SPL_TOKEN_PROGRAM,
    });
    h.putAccount(ataAddress(usdcMint, wallet, SPL_TOKEN_PROGRAM), u.data, u.owner);
  }

  const join = (wallet: anchor.web3.Keypair, stockRaw: bigint) =>
    call(h.program, "joinAndLock", [new BN(stockRaw.toString())])
      .accounts({
        wallet: wallet.publicKey,
        circle,
        member: memberAddress(wallet.publicKey),
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        memberStockAta: ataAddress(stockMint, wallet.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, wallet.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

  const contribute = (wallet: anchor.web3.Keypair) =>
    call(h.program, "contribute", [])
      .accounts({
        wallet: wallet.publicKey,
        circle,
        member: memberAddress(wallet.publicKey),
        usdcMint,
        memberUsdcAta: ataAddress(usdcMint, wallet.publicKey, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([wallet])
      .rpc();

  /** Every Member account, writable, in turn order. */
  const memberMetas = () =>
    wallets.map((w) => ({
      pubkey: memberAddress(w.publicKey),
      isWritable: true,
      isSigner: false,
    }));

  const release = (caller: anchor.web3.Keypair, recipient: anchor.web3.PublicKey) =>
    call(h.program, "releasePot", [])
      .accounts({
        caller: caller.publicKey,
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        recipient,
        recipientUsdcAta: ataAddress(usdcMint, recipient, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(memberMetas())
      .signers([caller])
      .rpc();

  async function setUp(overrides: Partial<typeof DEMO> = {}, lock = LOCK_RAW) {
    const p = { ...DEMO, ...overrides };

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

    // Enough USDC for every round plus the guarantee.
    for (const w of wallets) {
      fundWallet(w.publicKey, lock * 2n, BigInt(p.guaranteePerMember + p.contribution * N * 2));
    }
    for (const w of wallets) await join(w, lock);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();
  }

  it("contribute takes exactly the contribution and sets only that seat's bit", async () => {
    await setUp();

    const before = await usdcOf(wallets[1]!.publicKey);
    await contribute(wallets[1]!);
    const after = await usdcOf(wallets[1]!.publicKey);

    assert.equal(before! - after!, BigInt(DEMO.contribution), "exactly one contribution left");

    const c = await readCircle();
    assert.equal(c.paidBitmap, 0b00010, "only seat 2's bit");
    assert.equal(c.heldContributions.toNumber(), DEMO.contribution);
    assert.equal((await readMember(wallets[1]!.publicKey)).roundsPaid, 1);
  });

  it("contribute refuses twice, and refuses a circle that is not Active", async () => {
    await setUp();

    await contribute(wallets[0]!);
    await h.nextSlot();
    assert.equal(await h.refusal(contribute(wallets[0]!)), "AlreadyContributed");

    // A Forming circle: build a second one and do not activate it.
    const other = await h.refusal(
      (async () => {
        const id = circleId++;
        const c2 = circleAddress(h.program, creator.publicKey, id);
        await call(h.program, "createCircle", [
          {
            circleId: new BN(Number(id)),
            contribution: new BN(DEMO.contribution),
            roundSecs: new BN(DEMO.roundSecs),
            graceSecs: new BN(DEMO.graceSecs),
            haircutBps: DEMO.haircutBps,
            coverageBps: DEMO.coverageBps,
            warnBps: DEMO.warnBps,
            guaranteePerMember: new BN(DEMO.guaranteePerMember),
            minStockCover: new BN(DEMO.minStockCover),
            maxPriceAge: new BN(DEMO.maxPriceAge),
          },
          wallets.map((w) => w.publicKey),
        ])
          .accounts({
            creator: creator.publicKey,
            circle: c2,
            stockMint,
            usdcMint,
            priceFeed: priceFeedAddress(h.program, stockMint),
            pool: poolAddress(h.program, usdcMint, stockMint)[0],
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const saved = circle;
        circle = c2;
        try {
          await join(wallets[0]!, LOCK_RAW);
          await contribute(wallets[0]!);
        } finally {
          circle = saved;
        }
      })(),
    );
    assert.equal(other, "CircleNotActive");
  });

  it("I6: the pot is refused until every seat has paid", async () => {
    await setUp();

    for (const w of wallets.slice(0, N - 1)) await contribute(w);
    assert.equal(
      await h.refusal(release(creator, wallets[0]!.publicKey)),
      "RoundNotFunded",
      "four of five is not funded",
    );

    await contribute(wallets[N - 1]!);
    await release(creator, wallets[0]!.publicKey);
  });

  it("I1 and I18: a healthy demo round pays the pot and leaves nothing Paused", async () => {
    await setUp();
    for (const w of wallets) await contribute(w);

    const before = await usdcOf(wallets[0]!.publicKey);
    await release(wallets[3]!, wallets[0]!.publicKey); // anyone may call it
    const after = await usdcOf(wallets[0]!.publicKey);

    assert.equal(after! - before!, BigInt(POT), "the recipient received n x c");

    const c = await readCircle();
    assert.equal(c.receivedBitmap, 0b00001);
    assert.equal(c.paidBitmap, 0, "the new round starts unpaid");
    assert.equal(c.heldContributions.toNumber(), 0, "nothing is held into the new round");
    assert.equal(c.round, 1);
    assert.equal(
      c.roundDeadline.toNumber(),
      BEFORE_SPLIT + DEMO.roundSecs,
      "the next deadline is now + round_secs",
    );
    assert.equal(
      c.nextGateShortBy.toNumber(),
      0,
      "I18: a healthy payout leaves the circle unpaused",
    );

    // I2: the allocations recorded are exactly what the gate summed.
    let sum = 0;
    for (const w of wallets) sum += (await readMember(w.publicKey)).allocated.toNumber();
    assert.equal(sum, c.reserveAllocated.toNumber(), "sum of member.allocated");

    // The recipient now owes; everyone else still owes nothing.
    const paid = await readMember(wallets[0]!.publicKey);
    const other = await readMember(wallets[1]!.publicKey);
    assert.notEqual(paid.lastCoverageBps, 0xffffffff, "the recipient owes now");
    assert.equal(other.lastCoverageBps, 0xffffffff, "nobody else owes yet");
  });

  it("I10: exactly n payouts, each seat once, then Completed", async () => {
    await setUp();

    const seen: number[] = [];
    for (let round = 0; round < N; round += 1) {
      for (const w of wallets) await contribute(w);
      await release(creator, wallets[round]!.publicKey);
      seen.push((await readCircle()).receivedBitmap);
    }

    assert.deepEqual(
      seen,
      [0b00001, 0b00011, 0b00111, 0b01111, 0b11111],
      "one new bit per round, in turn order",
    );

    const c = await readCircle();
    assert.ok("completed" in c.status, "Completed after n payouts");
    assert.equal(c.nextGateShortBy.toNumber(), 0);

    // Everyone has paid every round and received exactly once.
    for (const w of wallets) {
      assert.equal((await readMember(w.publicKey)).roundsPaid, N);
    }

    // And a sixth payout is impossible.
    assert.equal(
      await h.refusal(release(creator, wallets[0]!.publicKey)),
      "CircleNotActive",
    );
  });

  /**
   * KNOWN-LIMITS L4: the create-time peak check makes a failing gate
   * unreachable "without a default or price fall". That is not a footnote, it
   * is why this test exists in the shape it does. The first attempt at it built
   * a circle whose coverage target the reserve could not meet, and
   * create_circle refused it with GuaranteeBelowPeakNeed before the gate could
   * ever run. So the only honest way to reach a refusal in gate 2, before
   * defaults exist in T15, is to let the price fall under a circle that was
   * correctly created.
   */
  it("I1: a price fall takes the gate below the line, and it refuses with the numbers", async () => {
    await setUp();
    for (const w of wallets) await contribute(w);

    // 150 -> 50. H falls from 132 to floor(1.1 x 50 x 0.8) = 44 USDC, under the
    // 120 minimum this circle was joined at.
    await setPrices(h, stockMint, {
      wrapper: 50 * USDC,
      share: 50 * USDC,
      stamp: CURRENT,
      expected: ONE_X,
    });

    const refusal = await h.refusal(release(creator, wallets[0]!.publicKey));

    // SPEC §5: coverage_too_low iff H_r is under the minimum AND everyone
    // else's need still fits. Both hold here, because nobody but the recipient
    // has received yet, so their stock is the whole gap and "lock more stock"
    // is advice that would actually work.
    assert.equal(refusal, "CoverageTooLow");

    const c = await readCircle();
    assert.equal(c.receivedBitmap, 0, "no payout was recorded");
    assert.equal(c.heldContributions.toNumber(), POT, "the round is still funded and held");
    assert.equal(
      (await usdcOf(circle))!,
      BigInt(DEMO.guaranteePerMember * N + POT),
      "not one base unit left the vault",
    );
  });

  it("the same fall later refuses as Paused instead, because the stock is no longer the whole gap", async () => {
    await setUp();

    // Round 1 pays cleanly at the real price.
    for (const w of wallets) await contribute(w);
    await release(creator, wallets[0]!.publicKey);

    // Now two members are in the gate sum: seat 1 received, seat 2 is about to.
    // Both have paid 2 rounds, so each owes 50 x (5 - 2) = 150 and needs
    // ceil(150 x 1.3) = 195 of cover.
    //
    // The price has to fall further than the first case to reach this branch,
    // and working out why is the point. At 50 a token, H is 44, each need is
    // 151, and others_need is 151, which still fits inside the 175 reserve, so
    // SPEC correctly calls the recipient's own stock the whole gap. At 20 a
    // token H is 17, each need is 178, and others_need alone is 178: more than
    // the reserve holds. Now locking more stock would not release the pot, and
    // the refusal has to say so.
    for (const w of wallets) await contribute(w);
    await setPrices(h, stockMint, {
      wrapper: 20 * USDC,
      share: 20 * USDC,
      stamp: CURRENT,
      expected: ONE_X,
    });

    assert.equal(
      await h.refusal(release(creator, wallets[1]!.publicKey)),
      "ReserveOvercommitted",
      "others_need alone exceeds the reserve, so locking more stock would not release it",
    );
  });

  it("refuses member accounts that are not this circle's seats in order", async () => {
    await setUp();
    for (const w of wallets) await contribute(w);

    const wrong = [...memberMetas()].reverse();
    const promise = call(h.program, "releasePot", [])
      .accounts({
        caller: creator.publicKey,
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        recipient: wallets[0]!.publicKey,
        recipientUsdcAta: ataAddress(usdcMint, wallets[0]!.publicKey, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(wrong)
      .signers([creator])
      .rpc();

    assert.equal(await h.refusal(promise), "BadMemberAccounts");
  });

  it("refuses paying anyone but the seat whose turn it is", async () => {
    await setUp();
    for (const w of wallets) await contribute(w);

    assert.equal(
      await h.refusal(release(creator, wallets[2]!.publicKey)),
      "BadMemberAccounts",
      "seat 3 cannot be paid in round 1",
    );
  });
});
