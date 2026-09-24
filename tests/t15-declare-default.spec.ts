/**
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
  nextGateShortBy: Big;
  lastCoverageAt: Big;
};
type MemberState = {
  turn: number;
  roundsPaid: number;
  stockRaw: Big;
  allocated: Big;
  forfeited: Big;
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

describe("T15 declare_default", () => {
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

  it("settles the demo default: sells all 1.1 tokens for 132, the reserve absorbs 68, forfeit 35 (I9, I15)", async () => {
    await setUp();
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit();

    const before = { circleUsdc: await circleUsdc(), poolUsdc: await poolUsdc(), poolStock: await poolStock() };
    const e = await declare(0);

    assert.equal(big(e.obligations), u(200), "O = 50 x (5 - 1)");
    assert.equal(big(e.sellRaw), LOCK_RAW, "all of it: 1.1 x 120 = 132 < 200");
    assert.equal(big(e.recovered), u(132));
    assert.equal(big(e.shortfall), u(68));
    assert.equal(big(e.loss), u(68));
    assert.equal(big(e.deficit), 0n);
    assert.equal(big(e.forfeited), u(35), "r3: min(shortfall 68, own guarantee 35)");
    assert.equal(e.recomputed, true, "priced for the multiplier in force");

    // I9 on chain: what moved is exactly the sale, at the conservative price.
    assert.equal((await poolStock()) - before.poolStock, LOCK_RAW);
    assert.equal(before.poolUsdc - (await poolUsdc()), u(132));
    assert.equal((await circleUsdc()) - before.circleUsdc, u(132));

    const c = await readCircle();
    assert.equal(c.defaultedBitmap, 0b00001);
    assert.equal(big(c.reserveLosses), u(68));
    assert.equal(big(c.escrow), u(200), "funded 132 + loss 68");
    assert.equal(big(c.forfeitedTotal), u(35));
    const d = await readMember(0);
    assert.equal(big(d.stockRaw), 0n);
    assert.equal(big(d.allocated), 0n);
    assert.equal(big(d.forfeited), u(35));
    await assertBooks("after the default");
  });

  it("then the escrow pays the defaulted seat every round and the circle completes (I6, I10)", async () => {
    await setUp();
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit();
    await declare(0);

    const received = new Set<number>([0]);
    for (let round = 1; round < N; round++) {
      if (round > 1) for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);
      const c = await readCircle();
      assert.equal(c.round, round);
      await release();
      received.add(round);
      await assertBooks(`after release ${round}`);
    }

    const c = await readCircle();
    assert.deepEqual(Object.keys(c.status), ["completed"]);
    assert.equal(c.receivedBitmap, 0b11111, "I10: every seat received exactly once");
    assert.equal(big(c.escrow), 0n, "four rounds of 50 drew the 200 down to nothing");
    assert.equal(received.size, N);

    // A finished circle cannot be defaulted: there is no next round to fund.
    await h.setClock(Number(big(c.roundDeadline)) + DEMO.graceSecs + 1);
    assert.equal(await h.refusal(declareIx(1).rpc()), "CircleNotActive");
  });

  it("sells only what is owed on a late default and leaves the rest of the stock (I9)", async () => {
    await setUp();
    // Three full rounds, so seat 0 has paid 3; it misses round 3.
    for (let r = 0; r < 3; r++) {
      for (const w of wallets) await contribute(w);
      await release();
    }
    for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);
    await h.setClock(await pastGrace());
    await repriceForSplit();

    const e = await declare(0);
    assert.equal(big(e.obligations), u(100), "O = 50 x (5 - 3)");
    assert.equal(big(e.sellRaw), 83_333_334n, "ceil(100 / 120 tokens)");
    assert.equal(big(e.recovered), u(100));
    assert.equal(big(e.shortfall), 0n);
    assert.equal(big(e.forfeited), 0n, "I15: nothing consumed, nothing forfeited");
    assert.equal(big((await readMember(0)).stockRaw), LOCK_RAW - 83_333_334n, "the surplus stays the defaulter's");
    await assertBooks("after a late default");
  });

  it("I7: refuses at exactly deadline + grace and accepts one second later, measured from a LATE release", async () => {
    await setUp();
    for (const w of wallets) await contribute(w);
    // Release 1,000 seconds late. The next round's deadline runs from the
    // release, not from the round's nominal start, so seat 0 is not
    // defaultable for round_secs + grace after this moment.
    await h.setClock(T0 + 1_000);
    await repriceForSplit();
    await release();
    for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);

    const c = await readCircle();
    assert.equal(Number(big(c.roundDeadline)), T0 + 1_000 + DEMO.roundSecs);

    await h.setClock(T0 + 1_000 + DEMO.roundSecs + DEMO.graceSecs);
    assert.equal(await h.refusal(declareIx(0).rpc()), "GraceNotElapsed");

    await h.setClock(T0 + 1_000 + DEMO.roundSecs + DEMO.graceSecs + 1);
    await declare(0);
    assert.equal((await readCircle()).defaultedBitmap, 0b00001);
  });

  it("refuses a seat that paid, a seat before its payout, a second default, and a turn out of range", async () => {
    await setUp();
    await firstRecipientMissesRoundOne([0, 2]);
    await h.setClock(await pastGrace());
    await repriceForSplit();

    assert.equal(await h.refusal(declareIx(1).rpc()), "SeatAlreadyPaid");
    assert.equal(await h.refusal(declareIx(2).rpc()), "PrePayoutDefaultUnsupported", "seat 2 has not received");
    assert.equal(await h.refusal(declareIx(5).rpc()), "InvalidParams");

    await declare(0);
    await h.nextSlot();
    assert.equal(await h.refusal(declareIx(0).rpc()), "AlreadyDefaulted");
  });

  it("refuses a stale wrapper price, and refuses when the pool cannot pay", async () => {
    await setUp({}, 100n * BigInt(USDC));
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit();

    assert.equal(await h.refusal(declareIx(0).rpc()), "PoolInsufficient", "the sale needs 132; the pool holds 100");

    await h.setClock(await pastGrace() + DEMO.maxPriceAge + 1);
    assert.equal(await h.refusal(declareIx(0).rpc()), "PriceStale");
  });

  it("still settles while Repricing, and the capped branch keeps I2 without stamping coverage (I13)", async () => {
    await setUp();
    await firstRecipientMissesRoundOne();
    const before = await readCircle();
    // Past the split, and NOT re-priced: the feed is still stamped 1x while the
    // mint says 10x. release_pot and update_coverage refuse in this state.
    await h.setClock(await pastGrace());

    const e = await declare(0);
    assert.equal(e.recomputed, false, "the capped branch ran");
    assert.equal(big(e.sellRaw), LOCK_RAW, "the sale used the wrapper price only");
    assert.equal(big(e.recovered), u(132));

    const c = await readCircle();
    assert.equal(big(c.lastCoverageAt), big(before.lastCoverageAt), "nothing was valued, so nothing is stamped");
    assert.equal(big(c.nextGateShortBy), big(before.nextGateShortBy) + big(e.deficit));
    await assertBooks("capped branch");
  });

  it("while Repricing, a deficit still pauses the circle: next_gate_short_by grows by exactly the deficit", async () => {
    // The price fell before the split (wrapper 50, still stamped 1x), then the
    // split took effect and nobody re-priced. The capped branch cannot value
    // anyone, so Paused must move by what the reserve could not absorb.
    await setUp({ guaranteePerMember: 30 * USDC });
    for (const w of wallets) await contribute(w);
    await release();
    await setPrices(h, stockMint, { wrapper: 50 * USDC, share: 50 * USDC, stamp: CURRENT, expected: ONE_X });
    for (const [i, w] of wallets.entries()) if (i !== 0) await contribute(w);
    const before = await readCircle();
    await h.setClock(await pastGrace());

    const e = await declare(0);
    assert.equal(e.recomputed, false);
    assert.equal(big(e.deficit), u(6), "44 recovered, 150 absorbed, 6 left over");

    const c = await readCircle();
    assert.equal(big(c.nextGateShortBy), big(before.nextGateShortBy) + u(6));
    assert.equal(big(c.escrowDeficit), u(6));
    await assertBooks("capped branch with a deficit");
  });

  it("turns what the reserve cannot absorb into an escrow deficit and pauses the circle", async () => {
    // Guarantee 30 (reserve 150, the peak) and a wrapper that fell to 50
    // before the default: 1.1 tokens at 40 recover 44 of the 200 owed, so the
    // shortfall of 156 exceeds the reserve by 6.
    await setUp({ guaranteePerMember: 30 * USDC });
    await firstRecipientMissesRoundOne();
    await h.setClock(await pastGrace());
    await repriceForSplit(50 * USDC);

    const e = await declare(0);
    assert.equal(big(e.recovered), u(44));
    assert.equal(big(e.shortfall), u(156));
    assert.equal(big(e.loss), u(150));
    assert.equal(big(e.deficit), u(6));
    assert.equal(big(e.forfeited), u(30), "capped at the defaulter's own guarantee");

    const c = await readCircle();
    assert.equal(big(c.escrowDeficit), u(6));
    assert.ok(big(c.nextGateShortBy) >= u(6), "Paused, by at least the deficit");
    await assertBooks("deficit");
  });
});
