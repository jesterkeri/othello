/**
 * T16 ADVERSARY PASS, written by the adversary subagent against abc68c0 and
 * integrated unchanged. No defect found in 7 attacks (A1 to A7 below). The
 * circle driver and the header that follows are copied from
 * t16-top-up.spec.ts so both files drive the same circle.
 */
/**
 * T16: top_up_reserve and add_stock, end to end on a real circle.
 *
 * TASKS T16's done-when: I14 and I18 green, and the SPEC §7 halt example
 * reproduced: needed 75, remaining 70, short_by 5, then a top-up of 5
 * resumes. The circle driver below is copied from the T15 spec so both drive
 * the same demo circle against a pool made by init_pool and seed_pool.
 *
 * (T15's own header follows, because the time handling it describes applies
 * here unchanged.)
 *
 * T15: declare_default and the SPEC §6 waterfall, end to end on a real circle.
 *
 * TASKS T15's done-when: I7, I9 and I15 green, and the Repricing branch keeps
 * I2. Every scenario here runs against a pool made by init_pool and funded by
 * seed_pool, not a fabricated account, so the sale moves real token balances
 * between the circle's vaults and the pool's.
 *
 * Time. The circle starts one second before NFLXx's real 10-for-1 split takes
 * effect, and a default is only possible after deadline + grace, so every
 * default here happens after the split. Scenarios that want the normal
 * recompute re-price the feed for the new multiplier first (share 15, stamped
 * 10x), exactly as the demo script does. The Repricing scenario deliberately
 * does not, which is the whole point of it.
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
  depositsTotal: Big;
  nextGateShortBy: Big;
  lastCoverageAt: Big;
};
type MemberState = {
  turn: number;
  guarantee: Big;
  topUps: Big;
  roundsPaid: number;
  stockRaw: Big;
  allocated: Big;
  forfeited: Big;
};
type RefusedEvent = {
  needed: Big;
  remaining: Big;
  shortBy: Big;
  recipientGap: Big;
  othersNeed: Big;
  escrowDeficit: Big;
  recipientCover: Big;
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

describe("T16 adversary", () => {
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

  const declareIx = (turn: number, caller = creator) =>
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
      .remainingAccounts(memberMetas())
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

  async function setUp(overrides: Partial<typeof DEMO> = {}, poolSeed = POOL_SEED, lock = LOCK_RAW) {
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
    for (const w of wallets) await join(w, lock);
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

  const topUpIx = (w: anchor.web3.Keypair, amount: bigint) =>
    call(h.program, "topUpReserve", [new BN(amount.toString())])
      .accounts({
        wallet: w.publicKey,
        circle,
        member: memberAddress(w.publicKey),
        usdcMint,
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([w]);

  const addStockIx = (w: anchor.web3.Keypair, raw: bigint) =>
    call(h.program, "addStock", [new BN(raw.toString())])
      .accounts({
        wallet: w.publicKey,
        circle,
        member: memberAddress(w.publicKey),
        stockMint,
        memberStockAta: ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
      })
      .signers([w]);

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

  const walletUsdc = (w: anchor.web3.Keypair) => balance(ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM));

  /**
   * The SPEC §7 halt example (design review r4): g = 30, 1.0 token each so
   * H = 120, round 0 released, seat 0 misses round 1 and is defaulted. Its
   * 1.0 token sells for 120 of the 200 it owes, the reserve absorbs 80, and
   * R - L = 70 while round 1's gate needs 75.
   */
  async function haltExample() {
    await setUp({ guaranteePerMember: 30 * USDC }, POOL_SEED, 100_000_000n);
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit();
    const e = await declare(0);
    assert.equal(big(e.recovered), u(120));
    assert.equal(big(e.loss), u(80));
  }

  /** The T15 deficit circle: g = 30, wrapper 50 at default, deficit 6, short_by 157. */
  async function deficitExample() {
    await setUp({ guaranteePerMember: 30 * USDC });
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit(50 * USDC);
    const e = await declare(0);
    assert.equal(big(e.deficit), u(6));
    assert.equal(big((await readCircle()).nextGateShortBy), u(157));
  }

  /** Drives a defaulted circle to Completed, curing each Paused from `payer`. */
  async function driveToCompletion(payer: anchor.web3.Keypair, beforeLastRelease?: () => Promise<void>) {
    for (let round = 1; round < N; round++) {
      if (round > 1) for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);
      const short = big((await readCircle()).nextGateShortBy);
      if (short > 0n) await topUpIx(payer, short).rpc();
      if (round === N - 1 && beforeLastRelease) await beforeLastRelease();
      await release();
      await assertBooks(`round ${round}`);
    }
    assert.deepEqual(Object.keys((await readCircle()).status), ["completed"]);
  }

  async function withdrawAll() {
    const got: bigint[] = [];
    for (const w of wallets) {
      const before = await walletUsdc(w);
      await withdraw(w);
      got.push((await walletUsdc(w)) - before);
    }
    return got;
  }

  it("A1: top_up_reserve refuses another seat, another's token account, a foreign vault and the wrong token program", async () => {
    await haltExample();
    const attacker = wallets[2]!;
    const victim = wallets[1]!;
    const circleBefore = JSON.stringify(await readCircle());
    const victimAtaBefore = await walletUsdc(victim);

    const base = {
      wallet: attacker.publicKey,
      circle,
      member: memberAddress(attacker.publicKey),
      usdcMint,
      memberUsdcAta: ataAddress(usdcMint, attacker.publicKey, SPL_TOKEN_PROGRAM),
      circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
      usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
    };
    const attempt = (over: Record<string, anchor.web3.PublicKey>) =>
      call(h.program, "topUpReserve", [new BN(u(5).toString())])
        .accounts({ ...base, ...over })
        .signers([attacker])
        .rpc();

    const codes = [
      await h.refusal(attempt({ member: memberAddress(victim.publicKey) })),
      await h.refusal(attempt({ memberUsdcAta: ataAddress(usdcMint, victim.publicKey, SPL_TOKEN_PROGRAM) })),
      await h.refusal(attempt({ circleUsdcVault: ataAddress(usdcMint, wallets[3]!.publicKey, SPL_TOKEN_PROGRAM) })),
      await h.refusal(attempt({ usdcTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM) })),
    ];
    console.log("      A1 refusals:", codes.join(", "));
    assert.equal(JSON.stringify(await readCircle()), circleBefore);
    assert.equal(await walletUsdc(victim), victimAtaBefore);
  });

  it("A2: add_stock refuses another seat, another's stock account, a foreign vault and the wrong mint", async () => {
    await haltExample();
    const attacker = wallets[2]!;
    const victim = wallets[1]!;
    const victimStock = ataAddress(stockMint, victim.publicKey, TOKEN_2022_PROGRAM);
    const victimBefore = await balance(victimStock);
    const base = {
      wallet: attacker.publicKey,
      circle,
      member: memberAddress(attacker.publicKey),
      stockMint,
      memberStockAta: ataAddress(stockMint, attacker.publicKey, TOKEN_2022_PROGRAM),
      circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
      stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
    };
    const attempt = (over: Record<string, anchor.web3.PublicKey>) =>
      call(h.program, "addStock", [new BN("1000")]).accounts({ ...base, ...over }).signers([attacker]).rpc();
    const codes = [
      await h.refusal(attempt({ member: memberAddress(victim.publicKey) })),
      await h.refusal(attempt({ memberStockAta: victimStock })),
      await h.refusal(attempt({ circleStockVault: ataAddress(stockMint, wallets[3]!.publicKey, TOKEN_2022_PROGRAM) })),
      await h.refusal(attempt({ stockMint: usdcMint })),
    ];
    console.log("      A2 refusals:", codes.join(", "));
    assert.equal(await balance(victimStock), victimBefore);
    assert.equal(big((await readMember(1)).stockRaw), 100_000_000n);
    await assertBooks("after refused add_stock attempts");
  });

  it("A3: a partial deficit fill and an over-sized top-up keep I3 and SPEC §5's short_by", async () => {
    await deficitExample();
    const payer = wallets[4]!;
    put(usdcMint, payer.publicKey, 5_000n * BigInt(USDC), SPL_TOKEN_PROGRAM);
    await topUpIx(payer, u(4)).rpc();
    let c = await readCircle();
    assert.equal(big(c.escrowDeficit), u(2));
    assert.equal(big(c.nextGateShortBy), u(153));
    await assertBooks("partial fill");
    await h.nextSlot();
    await topUpIx(payer, u(1000)).rpc();
    c = await readCircle();
    assert.equal(big(c.escrowDeficit), 0n);
    assert.equal(big(c.nextGateShortBy), 0n);
    await assertBooks("over-sized top-up");
    await release();
    assert.equal((await readCircle()).round, 2);
    await assertBooks("released");
  });

  it("A4: add_stock after leave_forming, and by a member who never joined, is refused", async () => {
    await setUp();
    const id = circleId++;
    const forming = circleAddress(h.program, creator.publicKey, id);
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
        circle: forming,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    circle = forming;
    const w = wallets[1]!;
    put(stockMint, w.publicKey, LOCK_RAW * 3n, TOKEN_2022_PROGRAM);
    put(usdcMint, w.publicKey, 1_000n * BigInt(USDC), SPL_TOKEN_PROGRAM);
    console.log("      never joined:", await h.refusal(addStockIx(w, 1_000n).rpc()));
    await join(w, LOCK_RAW);
    await addStockIx(w, 5_000n).rpc();
    const vaultBefore = await circleStock();
    await call(h.program, "leaveForming", [])
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
    assert.equal(vaultBefore - (await circleStock()), LOCK_RAW + 5_000n, "leave_forming returned the added stock too");
    await h.nextSlot();
    console.log("      after leave:", await h.refusal(addStockIx(w, 1_000n).rpc()));
    assert.equal(await circleStock(), 0n);
  });

  it("A5: stock added before a default is sold only up to O, and the surplus comes back at withdraw", async () => {
    await setUp({ guaranteePerMember: 30 * USDC });
    const d = wallets[0]!;
    put(stockMint, d.publicKey, 1_000_000_000n, TOKEN_2022_PROGRAM);
    for (const w of wallets) await contribute(w);
    await addStockIx(d, 500_000_000n).rpc();
    await release();
    for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);
    await h.setClock(await pastGrace());
    await repriceForSplit();
    const e = await declare(0);
    const m0 = await readMember(0);
    assert.equal(big(m0.stockRaw), LOCK_RAW + 500_000_000n - big(e.sellRaw));
    assert.equal(big(e.shortfall), 0n, "the added stock covers everything owed");
    await assertBooks("after default");
    console.log("      addStock-while-defaulted:", await h.refusal(addStockIx(d, 1n).rpc()));
    await driveToCompletion(wallets[4]!);
    const stockBefore = await balance(ataAddress(stockMint, d.publicKey, TOKEN_2022_PROGRAM));
    await withdraw(d);
    const back = (await balance(ataAddress(stockMint, d.publicKey, TOKEN_2022_PROGRAM))) - stockBefore;
    assert.equal(back, big(m0.stockRaw), "the surplus stock came back");
    await assertBooks("after the defaulter withdrew");
  });

  it("A6: a late top-up before the last payout neither profits the topper nor costs the others", async () => {
    // Baseline.
    await deficitExample();
    put(usdcMint, wallets[4]!.publicKey, 5_000n * BigInt(USDC), SPL_TOKEN_PROGRAM);
    await driveToCompletion(wallets[4]!);
    const baseline = await withdrawAll();

    // Same circle, plus a late top-up of 500 by seat 2 just before the final release.
    await deficitExample();
    put(usdcMint, wallets[4]!.publicKey, 5_000n * BigInt(USDC), SPL_TOKEN_PROGRAM);
    const late = u(500);
    put(usdcMint, wallets[2]!.publicKey, 5_000n * BigInt(USDC), SPL_TOKEN_PROGRAM);
    await driveToCompletion(wallets[4]!, async () => {
      await topUpIx(wallets[2]!, late).rpc();
      await assertBooks("late top-up");
    });
    const c = await readCircle();
    const after = await withdrawAll();
    console.log("      baseline:", baseline.map(String).join(","), " with late top-up:", after.map(String).join(","));
    assert.ok(after[2]! - baseline[2]! <= late, "the late topper gets back at most what they added");
    for (const i of [0, 1, 3, 4]) assert.ok(after[i]! >= baseline[i]!, `seat ${i} not diluted by the late top-up`);
    assert.ok(big(c.withdrawnUsdc) <= big(c.depositsTotal) - big(c.reserveLosses), "I11");
    console.log("      completed topUp:", await h.refusal(topUpIx(wallets[2]!, 1n).rpc()));
    console.log("      completed addStock:", await h.refusal(addStockIx(wallets[2]!, 1n).rpc()));
  });

  it("A7: add_stock while the feed is repricing is allowed and keeps I4", async () => {
    await setUp();
    await h.setClock(T0 + 10);
    await addStockIx(wallets[3]!, 7n).rpc();
    assert.equal(big((await readMember(3)).stockRaw), LOCK_RAW + 7n);
    await assertBooks("repricing add_stock");
  });
});

