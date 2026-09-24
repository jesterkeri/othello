/**
 * T15 adversary pass: attacks on declare_default that the T15 spec does not
 * already cover.
 *
 * Written by the adversary subagent against 23bcf58, where its first test
 * FAILED: the capped branch left the defaulter's last_coverage_bps at 13000
 * instead of SPEC.md:70's u32::MAX. Fixed in declare_default; the test is kept
 * as the regression guard, renamed from "DEFECT: ..." now that it passes. The circle set-up is
 * copied from t15-declare-default.spec.ts so both files drive the same demo
 * circle (SPEC.md:137) against a pool made by init_pool and seed_pool.
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
  TEN_X,
  TOKEN_2022_PROGRAM,
  ataAddress,
  call,
  circleAddress,
  decodeEvent,
  fetchAccount,
  harness,
  initFeed,
  initPoolIx,
  poolAddress,
  priceFeedAddress,
  seedPoolIx,
  send,
  setPrices,
  splMintAccount,
  tokenAccount,
  tokenAmount,
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000;

/** SPEC.md:135, the demo circle. */
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
const LOCK_RAW = 110_000_000n;
const PRICE = 150 * USDC;
const DISCOUNT = 2000;
const POOL_SEED = 1_000n * BigInt(USDC);
const T0 = BEFORE_SPLIT;

type Big = { toString(): string };
type CircleState = {
  status: Record<string, unknown>;
  round: number;
  paidBitmap: number;
  receivedBitmap: number;
  defaultedBitmap: number;
  roundDeadline: Big;
  reserveTotal: Big;
  reserveLosses: Big;
  reserveAllocated: Big;
  escrow: Big;
  escrowDeficit: Big;
  heldContributions: Big;
  withdrawnUsdc: Big;
  forfeitedTotal: Big;
  nextGateShortBy: Big;
  lastCoverageAt: Big;
};
type MemberState = {
  turn: number;
  roundsPaid: number;
  stockRaw: Big;
  allocated: Big;
  forfeited: Big;
  lastCoverageBps: number;
};
type DefaultEvent = {
  obligations: Big;
  sellRaw: Big;
  recovered: Big;
  shortfall: Big;
  loss: Big;
  deficit: Big;
  forfeited: Big;
  recomputed: boolean;
};

const big = (v: Big) => BigInt(v.toString());
const u = (usdc: number) => BigInt(usdc * USDC);

describe("T15 adversary", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let pool: anchor.web3.PublicKey;
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
  const readMember = (i: number) => fetchAccount<MemberState>(h.program, "member", memberAddress(wallets[i]!.publicKey));
  const balance = async (address: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(address);
    return info ? tokenAmount(Buffer.from(info.data)) : 0n;
  };
  const circleUsdc = () => balance(ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM));
  const circleStock = () => balance(ataAddress(stockMint, circle, TOKEN_2022_PROGRAM));
  const poolUsdc = () => balance(ataAddress(usdcMint, pool, SPL_TOKEN_PROGRAM));
  const poolStock = () => balance(ataAddress(stockMint, pool, TOKEN_2022_PROGRAM));

  const memberMetas = () =>
    wallets.map((w) => ({ pubkey: memberAddress(w.publicKey), isWritable: true, isSigner: false }));

  const put = (mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, amount: bigint, program: string) => {
    const t = tokenAccount({ mint, owner, amount, tokenProgram: program });
    h.putAccount(ataAddress(mint, owner, program), t.data, t.owner);
  };

  const join = (w: anchor.web3.Keypair, raw: bigint) =>
    call(h.program, "joinAndLock", [new BN(raw.toString())])
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

  const contribute = (w: anchor.web3.Keypair) =>
    call(h.program, "contribute", [])
      .accounts({
        wallet: w.publicKey,
        circle,
        member: memberAddress(w.publicKey),
        usdcMint,
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([w])
      .rpc();

  const release = async () => {
    const c = await readCircle();
    const recipient = wallets[c.round]!.publicKey;
    return call(h.program, "releasePot", [])
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
      .remainingAccounts(memberMetas())
      .signers([creator])
      .rpc();
  };

  const declareIx = (turn: number, caller = creator, seats = memberMetas()) =>
    call(h.program, "declareDefault", [turn])
      .accounts({
        caller: caller.publicKey,
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool,
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        poolStockVault: ataAddress(stockMint, pool, TOKEN_2022_PROGRAM),
        poolUsdcVault: ataAddress(usdcMint, pool, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .remainingAccounts(seats)
      .signers([caller]);

  /** Sends declare_default and returns its decoded DefaultDeclared event. */
  const declare = async (turn: number, caller = h.fund()) => {
    const meta = await send(h, await declareIx(turn, caller).instruction(), caller);
    const event = decodeEvent<DefaultEvent>(h.program, "defaultDeclared", meta.logMessages);
    assert.ok(event, "DefaultDeclared was emitted");
    return event;
  };

  /** The feed re-priced for the multiplier in force after the split: share 15, stamped 10x. */
  const repriceForSplit = (wrapper = PRICE) =>
    setPrices(h, stockMint, { wrapper, share: wrapper / 10, stamp: CURRENT, expected: TEN_X });

  /** I2, I3 and I4, checked together after an instruction. */
  async function assertBooks(label: string) {
    const c = await readCircle();
    const members = await Promise.all(wallets.map((_, i) => readMember(i)));
    const allocated = members.reduce((s, m) => s + big(m.allocated), 0n);
    const stock = members.reduce((s, m) => s + big(m.stockRaw), 0n);
    const available = big(c.reserveTotal) - big(c.reserveLosses);

    assert.equal(allocated, big(c.reserveAllocated), `${label}: I2, Σ allocated = reserve_allocated`);
    assert.ok(big(c.reserveAllocated) <= available, `${label}: I2, reserve_allocated ≤ R − L`);
    const expectedVault = available + big(c.escrow) + big(c.heldContributions) - big(c.withdrawnUsdc);
    const vault = await circleUsdc();
    // "+ dust": recovered may exceed O by less than one raw unit's value.
    assert.ok(vault >= expectedVault && vault - expectedVault < 2n, `${label}: I3, vault ${vault} vs books ${expectedVault}`);
    assert.equal(await circleStock(), stock, `${label}: I4, stock vault = Σ stock_raw`);
  }

  async function setUp(overrides: Partial<typeof DEMO> = {}, poolSeed = POOL_SEED) {
    const p = { ...DEMO, ...overrides };
    h = await harness(["NFLXx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
    usdcMint = anchor.web3.Keypair.generate().publicKey;
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);

    await h.setClock(T0);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: PRICE, share: PRICE, stamp: CURRENT, expected: ONE_X });

    await initPoolIx(h, { usdcMint, stockMint, discountBps: DISCOUNT }).rpc();
    [pool] = poolAddress(h.program, usdcMint, stockMint);
    if (poolSeed > 0n) {
      put(usdcMint, h.authority.publicKey, poolSeed, SPL_TOKEN_PROGRAM);
      await seedPoolIx(h, { usdcMint, stockMint, amount: poolSeed }).rpc();
    }

    creator = h.fund(100 * anchor.web3.LAMPORTS_PER_SOL);
    wallets = [creator, ...Array.from({ length: N - 1 }, () => h.fund(100 * anchor.web3.LAMPORTS_PER_SOL))];
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

    for (const w of wallets) {
      put(stockMint, w.publicKey, LOCK_RAW * 2n, TOKEN_2022_PROGRAM);
      put(usdcMint, w.publicKey, BigInt(p.guaranteePerMember + p.contribution * N * 2), SPL_TOKEN_PROGRAM);
    }
    for (const w of wallets) await join(w, LOCK_RAW);
    await call(h.program, "activate", []).accounts({ creator: creator.publicKey, circle }).signers([creator]).rpc();
  }

  /** Round 0 paid in full and released to seat 0; round 1 paid by everyone except `skip`. */
  async function firstRecipientMissesRoundOne(skip = [0]) {
    for (const w of wallets) await contribute(w);
    await release();
    for (const [i, w] of wallets.entries()) if (!skip.includes(i)) await contribute(w);
  }

  const pastGrace = async () => {
    const c = await readCircle();
    return Number(big(c.roundDeadline)) + DEMO.graceSecs + 1;
  };


  const withdraw = (w: anchor.web3.Keypair) =>
    call(h.program, "withdraw", [])
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

  const U32_MAX = 0xffffffff;

  // SPEC.md:70 (Member.last_coverage_bps): "u32::MAX when O_i = 0 or member is
  // defaulted (obligations prepaid). UI renders u32::MAX as ... "Prepaid"
  // (defaulted), never a percentage". state.rs:164 restates it.
  it("the capped branch sets a defaulted member's coverage to Prepaid (u32::MAX), not a percentage", async () => {
    await setUp();
    await firstRecipientMissesRoundOne();
    const before = (await readMember(0)).lastCoverageBps;
    assert.notEqual(before, U32_MAX, "seat 0 owed 200 before its default, so it had a percentage");

    // Past the split and NOT re-priced: declare_default takes the capped branch.
    await h.setClock(await pastGrace());
    const e = await declare(0);
    assert.equal(e.recomputed, false, "the capped branch ran");
    assert.equal((await readCircle()).defaultedBitmap, 0b00001);

    assert.equal(
      (await readMember(0)).lastCoverageBps,
      U32_MAX,
      "a defaulted member's last_coverage_bps must read u32::MAX (Prepaid)",
    );
  });

  it("control: the normal branch does set the defaulter to u32::MAX", async () => {
    await setUp();
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit();
    const e = await declare(0);
    assert.equal(e.recomputed, true);
    assert.equal((await readMember(0)).lastCoverageBps, U32_MAX);
  });

  it("refuses reordered, duplicated and read-only Member accounts", async () => {
    await setUp();
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit();

    const metas = memberMetas();
    const swapped = [metas[1]!, metas[0]!, ...metas.slice(2)];
    const duplicated = [metas[0]!, metas[0]!, ...metas.slice(2)];
    const readOnly = metas.map((m, i) => (i === 3 ? { ...m, isWritable: false } : m));
    const short = metas.slice(0, 4);
    for (const [label, list] of [
      ["swapped", swapped],
      ["duplicated", duplicated],
      ["read-only", readOnly],
      ["short", short],
    ] as const) {
      // Passed as the ONLY seats: Anchor's remainingAccounts() appends, so
      // adding them to a builder that already had the honest list would fail
      // the length check and pass this test for the wrong reason.
      const ix = declareIx(0, creator, list as typeof metas);
      assert.equal(await h.refusal(ix.rpc()), "BadMemberAccounts", label);
      await h.nextSlot();
    }
    await declare(0);
    await assertBooks("after the honest call");
  });

  it("a defaulter cannot contribute again, and after completion withdraws only what it did not forfeit (I11, I15)", async () => {
    await setUp();
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit();
    await declare(0);
    assert.equal(await h.refusal(contribute(wallets[0]!)), "AlreadyDefaulted");

    for (let round = 1; round < N; round++) {
      if (round > 1) for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);
      if (round > 1) assert.equal(await h.refusal(contribute(wallets[0]!)), "AlreadyDefaulted");
      await release();
    }
    const c = await readCircle();
    assert.deepEqual(Object.keys(c.status), ["completed"]);

    let paidOut = 0n;
    for (const [i, w] of wallets.entries()) {
      const before = await circleUsdc();
      await withdraw(w);
      const got = before - (await circleUsdc());
      if (i === 0) assert.equal(got, 0n, "I15: forfeited 35 of 35, weight 0");
      paidOut += got;
    }
    const deposits = BigInt(N) * u(35);
    assert.ok(paidOut <= deposits - big(c.reserveLosses), `I11: ${paidOut} vs ${deposits - big(c.reserveLosses)}`);
    assert.equal(await circleStock(), 0n);
  });

});
