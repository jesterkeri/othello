/**
 * T11: update_coverage, and I2 as a property.
 *
 * I2 is stated in INVARIANTS.md as holding "after every instruction", not after
 * this one. So it is checked as a property here: `assertI2` runs after every
 * state-changing call in a realistic sequence, including the ones T09 and T10
 * introduced, and including after a price fall that makes the reserve scarce.
 *
 *   reserve_allocated <= reserve_total - reserve_losses
 *   sum(member.allocated) == circle.reserve_allocated
 *
 * The first half is a property of allocate_in_turn_order and is proved over
 * arbitrary inputs in gate.rs's unit tests. What is proved here is that every
 * instruction actually leaves the accounts in that state.
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
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000;
const N = 5;

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

const LOCK_RAW = 110_000_000n;
const PRICE = 150 * USDC;
const U32_MAX = 0xffffffff;

type CircleState = {
  status: Record<string, unknown>;
  round: number;
  reserveTotal: { toNumber(): number };
  reserveLosses: { toNumber(): number };
  reserveAllocated: { toNumber(): number };
  nextGateShortBy: { toNumber(): number };
  lastCoverageAt: { toNumber(): number };
};

type MemberState = {
  turn: number;
  roundsPaid: number;
  allocated: { toNumber(): number };
  lastCoverageBps: number;
};

describe("T11 update_coverage and I2", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let creator: anchor.web3.Keypair;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;
  let circleId = 0n;

  const memberAddress = (w: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), w.toBuffer()],
      h.program.programId,
    )[0];

  const readCircle = () => fetchAccount<CircleState>(h.program, "circle", circle);
  const readMember = (w: anchor.web3.PublicKey) =>
    fetchAccount<MemberState>(h.program, "member", memberAddress(w));

  /** INVARIANTS.md I2, checked wherever it is called. */
  async function assertI2(after: string) {
    const c = await readCircle();
    const free = c.reserveTotal.toNumber() - c.reserveLosses.toNumber();

    assert.ok(
      c.reserveAllocated.toNumber() <= free,
      `I2 after ${after}: allocated ${c.reserveAllocated.toNumber()} exceeds R - L ${free}`,
    );

    let sum = 0;
    for (const w of wallets) {
      const m = await h.context.banksClient.getAccount(memberAddress(w.publicKey));
      if (m) sum += (await readMember(w.publicKey)).allocated.toNumber();
    }
    assert.equal(
      sum,
      c.reserveAllocated.toNumber(),
      `I2 after ${after}: sum of member.allocated != circle.reserve_allocated`,
    );
  }

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

  const join = (wallet: anchor.web3.Keypair) =>
    call(h.program, "joinAndLock", [new BN(LOCK_RAW.toString())])
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

  const metas = (order = wallets) =>
    order.map((w) => ({
      pubkey: memberAddress(w.publicKey),
      isWritable: true,
      isSigner: false,
    }));

  const release = (recipient: anchor.web3.PublicKey) =>
    call(h.program, "releasePot", [])
      .accounts({
        caller: creator.publicKey,
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
      .remainingAccounts(metas())
      .signers([creator])
      .rpc();

  const recheck = (
    caller: anchor.web3.Keypair = creator,
    accounts = metas(),
  ) =>
    call(h.program, "updateCoverage", [])
      .accounts({
        caller: caller.publicKey,
        circle,
        stockMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
      })
      .remainingAccounts(accounts)
      .signers([caller])
      .rpc();

  const drop = (to: number) =>
    setPrices(h, stockMint, {
      wrapper: to * USDC,
      share: to * USDC,
      stamp: CURRENT,
      expected: ONE_X,
    });

  async function setUp() {
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
    await drop(150);

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
      fundWallet(w.publicKey, LOCK_RAW * 2n, BigInt(DEMO.guaranteePerMember + DEMO.contribution * N * 2));
    }
  }

  it("I2 holds after every instruction, through a full round and a price fall", async () => {
    await setUp();

    for (const w of wallets) {
      await join(w);
      await assertI2(`join ${w.publicKey.toBase58().slice(0, 4)}`);
    }

    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();
    await assertI2("activate");

    for (const w of wallets) {
      await contribute(w);
      await assertI2("contribute");
    }

    await release(wallets[0]!.publicKey);
    await assertI2("release_pot");

    await recheck();
    await assertI2("update_coverage at the real price");

    // Now make the reserve scarce and recheck: this is the case where the
    // allocation has to cap, and where a naive implementation would hand out
    // more than the circle holds.
    await drop(50);
    await recheck();
    await assertI2("update_coverage after a price fall");

    await drop(20);
    await recheck();
    await assertI2("update_coverage after a harder fall");
  });

  it("allocates in turn order, earliest recipient first, capped at what is left", async () => {
    await setUp();
    for (const w of wallets) await join(w);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    // Two rounds, so seats 1 and 2 have both received.
    for (const w of wallets) await contribute(w);
    await release(wallets[0]!.publicKey);
    for (const w of wallets) await contribute(w);
    await release(wallets[1]!.publicKey);

    // Everyone has paid 2 rounds, so each received member owes
    // 50 x (5 - 2) = 150 and needs ceil(150 x 1.3) = 195 of cover.
    // At 50 a token H is 44, so each needs 151. The reserve holds 175.
    await drop(50);
    await recheck();

    const seat1 = await readMember(wallets[0]!.publicKey);
    const seat2 = await readMember(wallets[1]!.publicKey);
    const seat3 = await readMember(wallets[2]!.publicKey);

    assert.equal(seat1.allocated.toNumber(), 151 * USDC, "the earliest recipient is filled first");
    assert.equal(seat2.allocated.toNumber(), 24 * USDC, "the next takes only what is left");
    assert.equal(seat3.allocated.toNumber(), 0, "and nothing remains for anyone after");

    const c = await readCircle();
    assert.equal(c.reserveAllocated.toNumber(), 175 * USDC, "which is exactly R - L");
    assert.ok(c.nextGateShortBy.toNumber() > 0, "and the circle now reads as Paused");
    await assertI2("the scarce allocation");
  });

  it("coverage saturates for a member who owes nothing, and is a number for one who does", async () => {
    await setUp();
    for (const w of wallets) await join(w);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    await recheck();
    for (const w of wallets) {
      assert.equal(
        (await readMember(w.publicKey)).lastCoverageBps,
        U32_MAX,
        "nobody has received, so nobody owes, so no percentage is meaningful",
      );
    }

    for (const w of wallets) await contribute(w);
    await release(wallets[0]!.publicKey);
    await recheck();

    assert.notEqual(
      (await readMember(wallets[0]!.publicKey)).lastCoverageBps,
      U32_MAX,
      "the member who received now owes, so coverage is a real number",
    );
    assert.equal(
      (await readMember(wallets[1]!.publicKey)).lastCoverageBps,
      U32_MAX,
      "and everyone else still owes nothing",
    );
  });

  it("validates the member accounts: order, count and writability", async () => {
    await setUp();
    for (const w of wallets) await join(w);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    assert.equal(
      await h.refusal(recheck(creator, metas([...wallets].reverse()))),
      "BadMemberAccounts",
      "reversed: index must equal turn, or allocation order could be chosen",
    );
    assert.equal(
      await h.refusal(recheck(creator, metas(wallets.slice(0, N - 1)))),
      "BadMemberAccounts",
      "too few",
    );
    assert.equal(
      await h.refusal(
        recheck(
          creator,
          metas().map((m, i) => (i === 0 ? { ...m, isWritable: false } : m)),
        ),
      ),
      "BadMemberAccounts",
      "read-only: an account that cannot be written cannot record an allocation",
    );
  });

  it("anyone can recheck, and a stale price refuses", async () => {
    await setUp();
    for (const w of wallets) await join(w);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    // A wallet with no seat in this circle, and no tokens in it.
    const stranger = h.fund(anchor.web3.LAMPORTS_PER_SOL);
    await recheck(stranger);
    assert.equal((await readCircle()).lastCoverageAt.toNumber(), BEFORE_SPLIT);

    await h.setClock(BEFORE_SPLIT + DEMO.maxPriceAge + 1);
    assert.equal(await h.refusal(recheck()), "PriceStale");
  });

  it("refuses once the circle is Completed", async () => {
    await setUp();
    for (const w of wallets) await join(w);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    for (let round = 0; round < N; round += 1) {
      for (const w of wallets) await contribute(w);
      await release(wallets[round]!.publicKey);
    }

    assert.equal(await h.refusal(recheck()), "CircleNotActive");
    assert.equal(
      (await readCircle()).nextGateShortBy.toNumber(),
      0,
      "a completed circle is never Paused",
    );
  });
});
