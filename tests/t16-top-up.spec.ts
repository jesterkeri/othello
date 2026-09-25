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

describe("T16 top_up_reserve and add_stock", () => {
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

  it("reproduces the SPEC §7 halt example, and a top-up of exactly short_by resumes it (I18)", async () => {
    await haltExample();

    const c = await readCircle();
    assert.equal(big(c.reserveTotal) - big(c.reserveLosses), u(70), "R - L = 70");
    assert.equal(big(c.escrow), u(200));
    assert.equal(big(c.nextGateShortBy), u(5), "Paused, by 5, before anyone tries to release");

    const logs = await h.failedLogs(release());
    const refused = decodeEvent<RefusedEvent>(h.program, "potRefused", logs);
    assert.ok(refused, "the refusal carries its numbers");
    assert.equal(big(refused.needed), u(75));
    assert.equal(big(refused.remaining), u(70));
    assert.equal(big(refused.shortBy), u(5));
    assert.equal(big(refused.recipientGap), u(75));
    assert.equal(big(refused.othersNeed), 0n);
    assert.equal(big(refused.escrowDeficit), 0n);
    assert.equal(big(refused.recipientCover), u(120));
    await h.nextSlot();
    assert.equal(await h.refusal(release()), "ReserveOvercommitted");

    // Seat 1, the recipient, tops up exactly short_by.
    const meta = await send(h, await topUpIx(wallets[1]!, u(5)).instruction(), wallets[1]!);
    const ev = decodeEvent<{ fill: Big; nextGateShortBy: Big }>(h.program, "reserveToppedUp", meta.logMessages);
    assert.ok(ev, "ReserveToppedUp was emitted");
    assert.equal(big(ev.fill), 0n, "no deficit, so all of it reached the reserve");
    assert.equal(big(ev.nextGateShortBy), 0n, "unpaused");
    assert.equal(big((await readCircle()).nextGateShortBy), 0n);
    await assertBooks("after the top-up");

    await h.nextSlot();
    await release();
    const after = await readCircle();
    assert.equal(after.round, 2, "the pot went out");
    assert.equal(after.receivedBitmap & 0b10, 0b10);
    await assertBooks("after the resumed release");
  });

  it("I14: an escrow deficit is curable, and the circle completes with every withdrawal inside the books (I11)", async () => {
    // T15's deficit: g = 30, and the wrapper fell to 50 before the default,
    // so 44 is recovered of 200 owed, the reserve absorbs 150 and 6 is left
    // as an escrow deficit.
    await setUp({ guaranteePerMember: 30 * USDC });
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit(50 * USDC);
    const e = await declare(0);
    assert.equal(big(e.deficit), u(6));

    // Every Paused is cured the way the UI says to: whoever tops up adds
    // exactly next_gate_short_by. The first top-up fills the deficit before
    // anything reaches the reserve.
    const payer = wallets[4]!;
    put(usdcMint, payer.publicKey, 2_000n * BigInt(USDC), SPL_TOKEN_PROGRAM);
    let toppedUp = 0n;
    const topUps: bigint[] = [];
    let firstFill: bigint | null = null;
    for (let round = 1; round < N; round++) {
      if (round > 1) for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);
      const short = big((await readCircle()).nextGateShortBy);
      if (short > 0n) {
        const meta = await send(h, await topUpIx(payer, short).instruction(), payer);
        const ev = decodeEvent<{ fill: Big; nextGateShortBy: Big }>(h.program, "reserveToppedUp", meta.logMessages);
        assert.ok(ev);
        if (firstFill === null) firstFill = big(ev.fill);
        assert.equal(big(ev.nextGateShortBy), 0n, `round ${round}: a top-up of exactly short_by unpauses`);
        toppedUp += short;
        topUps.push(short);
      }
      await release();
      await assertBooks(`round ${round}`);
    }

    assert.equal(firstFill, u(6), "the deficit was filled first");
    // Two top-ups, not one, because the price fell. Round 1: the 6 deficit
    // plus the recipient's need of 151 (O 150 x 1.3 = 195, cover 1.1 x 40 =
    // 44) against R - L = 0. Round 2: two received members each need 86
    // (O 100 x 1.3 = 130 - 44), 172 against the 151 that remains, so 21.
    // Each Paused is cured by exactly its own short_by; see OPEN-QUESTIONS
    // "I14 wording" on whether SPEC means one top-up or one per pause.
    assert.deepEqual(topUps, [u(157), u(21)]);
    const c = await readCircle();
    assert.deepEqual(Object.keys(c.status), ["completed"]);
    assert.equal(big(c.escrowDeficit), 0n);
    assert.equal(big(c.escrow), 0n);
    assert.ok(toppedUp > 0n);

    // The payer's top-ups are on their own seat, where withdraw reads them.
    assert.equal(big((await readMember(4)).topUps), toppedUp, "credited to the payer's seat");

    // Everyone withdraws, and each gets exactly SPEC §7's share:
    // floor((R - L + E) x (g + top_ups - forfeited) / (deposits_total - forfeited_total)).
    const snap = await readCircle();
    const poolLeft = big(snap.reserveTotal) - big(snap.reserveLosses) + big(snap.escrow);
    const denominator = big(snap.depositsTotal) - big(snap.forfeitedTotal);
    for (const [i, w] of wallets.entries()) {
      const m = await readMember(i);
      const weight = big(m.guarantee) + big(m.topUps) - big(m.forfeited);
      const before = await walletUsdc(w);
      await withdraw(w);
      const got = (await walletUsdc(w)) - before;
      assert.equal(got, (poolLeft * weight) / denominator, `seat ${i}: withdraw is the SPEC §7 share`);
    }
    const done = await readCircle();
    assert.ok(
      big(done.withdrawnUsdc) <= BigInt(30 * USDC * N) + toppedUp - big(done.reserveLosses),
      "I11",
    );
    await assertBooks("after every withdrawal");
  });

  it("refuses a top-up from a defaulted member, of zero, and of more than the wallet holds", async () => {
    await haltExample();
    assert.equal(await h.refusal(topUpIx(wallets[0]!, u(5)).rpc()), "AlreadyDefaulted");
    assert.equal(await h.refusal(topUpIx(wallets[1]!, 0n).rpc()), "InvalidParams");
    const held = await walletUsdc(wallets[1]!);
    assert.equal(await h.refusal(topUpIx(wallets[1]!, held + 1n).rpc()), "InsufficientBalance");
  });

  it("refuses a top-up on a Forming circle", async () => {
    await setUp();
    // Forming again: a second circle whose members have joined but which is
    // never activated. Reuse the driver by cancelling nothing; build it here.
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
    await join(creator, LOCK_RAW);
    assert.equal(await h.refusal(topUpIx(creator, u(5)).rpc()), "CircleNotActive");

    // add_stock, by contrast, is allowed while Forming (SPEC §5). The creator
    // has locked everything they held across the two circles, so hand them a
    // little more stock first.
    put(stockMint, creator.publicKey, 1_000n, TOKEN_2022_PROGRAM);
    await addStockIx(creator, 1_000n).rpc();
    assert.equal(big((await readMember(0)).stockRaw), LOCK_RAW + 1_000n);
  });

  it("add_stock locks more behind the signer's seat, keeps I4, and leaves Paused alone", async () => {
    await haltExample();
    const before = await readCircle();
    const vaultBefore = await circleStock();

    const meta = await send(h, await addStockIx(wallets[1]!, 50_000_000n).instruction(), wallets[1]!);
    const ev = decodeEvent<{ raw: Big; stockRaw: Big; turn: number }>(h.program, "stockAdded", meta.logMessages);
    assert.ok(ev, "StockAdded was emitted");
    assert.equal(big(ev.raw), 50_000_000n);
    assert.equal(big(ev.stockRaw), 150_000_000n);
    assert.equal(ev.turn, 1);

    assert.equal((await circleStock()) - vaultBefore, 50_000_000n);
    assert.equal(big((await readMember(1)).stockRaw), 150_000_000n);
    const after = await readCircle();
    assert.equal(big(after.nextGateShortBy), big(before.nextGateShortBy), "SPEC §5: add_stock does not refresh Paused");
    await assertBooks("after add_stock");

    // The extra half token covers the recipient's gap on its own: 1.5 x 120 =
    // 180 of cover against 195 required leaves a need of 15, well inside the
    // 70 that remains, so the gate passes with no top-up at all.
    await release();
    assert.equal((await readCircle()).round, 2);
  });

  it("refuses add_stock from a defaulted member, zero, and more than the wallet holds", async () => {
    await haltExample();
    assert.equal(await h.refusal(addStockIx(wallets[0]!, 1n).rpc()), "AlreadyDefaulted");
    assert.equal(await h.refusal(addStockIx(wallets[1]!, 0n).rpc()), "InvalidParams");
    const held = await balance(ataAddress(stockMint, wallets[1]!.publicKey, TOKEN_2022_PROGRAM));
    assert.equal(await h.refusal(addStockIx(wallets[1]!, held + 1n).rpc()), "InsufficientBalance");
  });
});
