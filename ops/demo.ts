/**
 * The demo circle (T24): SPEC §5's demo parameters, and every step that seeds
 * it, written once and run two ways. `ops/seed-demo-circle.ts` runs these
 * against devnet; `tests/t24-seed-demo.spec.ts` runs the SAME functions against
 * the devnet build in bankrun, so the seed is proven before it spends SOL.
 *
 * Every step checks the chain before acting, so a run that stops half way
 * (a dropped RPC, an empty faucet) is finished by running it again.
 *
 * SPEC.md:137, "Demo circle (G5 seed script, r3)":
 *   n=5, c=50 USDC, g=35 USDC, haircut 2000, coverage 13000, warn 11000,
 *   min_stock_cover 120 USDC, pool discount 2000, round 120 s, grace 60 s,
 *   max_price_age 691,200 s. Prices before the split: wrapper 150, share 150,
 *   multiplier 1.0. Each member locks 1.1 token. All members join BEFORE the
 *   split is scheduled. Split: schedule newMultiplier 10.0, then
 *   set_prices(wrapper 150, share 15, Scheduled, expected 10_000_000_000).
 */
import * as anchor from "@coral-xyz/anchor";

import {
  NFLXX_MIRROR_DECIMALS,
  SPL_TOKEN,
  TEST_USDC_DECIMALS,
  TOKEN_2022,
  ASSOCIATED_TOKEN,
  ataAddress,
  createAtaIdempotentIx,
  mintToCheckedIx,
  updateMultiplierIx,
} from "./devnet-mints.ts";

const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = anchor.web3;
// Under ESM, anchor's namespace import carries BN only on its default export
// (the same workaround as tests/harness.ts).
const { BN } = (anchor as unknown as { default: { BN: typeof anchor.BN } }).default;
type PublicKeyT = anchor.web3.PublicKey;
type KeypairT = anchor.web3.Keypair;
type Ix = anchor.web3.TransactionInstruction;

const USDC = 1_000_000;

export const DEMO = {
  n: 5,
  circleId: 0n,
  contribution: 50 * USDC,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13_000,
  warnBps: 11_000,
  guaranteePerMember: 35 * USDC,
  minStockCover: 120 * USDC,
  maxPriceAge: 691_200,
  poolDiscountBps: 2000,
  wrapperPrice: 150 * USDC,
  sharePrice: 150 * USDC,
  /** 1.1 token at 8 decimals. */
  lockRaw: 110_000_000n,
  /** Split: SPEC's 10-for-1, share 150 -> 15. */
  splitMultiplier: 10.0,
  splitSharePrice: 15 * USDC,
  ONE_X: 1_000_000_000n,
  TEN_X: 10_000_000_000n,
} as const;

/**
 * What each member is given: the guarantee plus every round's contribution,
 * and the stock they lock. Nothing more, so the demo shows real balances.
 */
export const MEMBER_USDC = BigInt(DEMO.guaranteePerMember + DEMO.contribution * DEMO.n);
export const MEMBER_STOCK = DEMO.lockRaw;
/** Lamports each member keeps for fees and the accounts join_and_lock pays for. */
export const MEMBER_LAMPORTS = 0.02 * LAMPORTS_PER_SOL;
/**
 * The pool buys seized stock at 80% of 150 = 120 USDC per token. One default
 * sells at most the defaulter's 1.1 token (132 USDC); 1,000 covers several.
 */
export const POOL_SEED_USDC = 1_000n * BigInt(USDC);

/**
 * The chain, as the seed needs it. Devnet and bankrun each supply one; the
 * steps below never know which they are talking to.
 */
export type Chain = {
  program: anchor.Program<anchor.Idl>;
  admin: KeypairT;
  send(ixs: Ix[], signers: KeypairT[]): Promise<void>;
  getAccount(address: PublicKeyT): Promise<{ lamports: number; data: Buffer; owner: PublicKeyT } | null>;
  /** Unix seconds by the CHAIN's clock, never the local machine's. */
  now(): Promise<number>;
  log(line: string): void;
};

export type Mints = { stock: PublicKeyT; usdc: PublicKeyT };

export function addresses(program: anchor.Program<anchor.Idl>, mints: Mints, creator: PublicKeyT) {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(DEMO.circleId);
  const circle = pda([Buffer.from("circle"), creator.toBuffer(), id]);

  return {
    feed: pda([Buffer.from("price"), mints.stock.toBuffer()]),
    pool: pda([Buffer.from("pool"), mints.usdc.toBuffer(), mints.stock.toBuffer()]),
    programData: PublicKey.findProgramAddressSync(
      [program.programId.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    )[0],
    circle,
    member: (wallet: PublicKeyT) => pda([Buffer.from("member"), circle.toBuffer(), wallet.toBuffer()]),
  };
}

/** SPL token account amount: u64 at byte 64, the same in SPL Token and Token-2022. */
async function tokenBalance(chain: Chain, ata: PublicKeyT): Promise<bigint> {
  const info = await chain.getAccount(ata);
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

type Builder = { accounts(a: unknown): Builder; instruction(): Promise<Ix> };
const methods = (program: anchor.Program<anchor.Idl>) =>
  program.methods as unknown as Record<string, (...a: unknown[]) => Builder>;

type Feed = { wrapperPrice: { toString(): string }; sharePrice: { toString(): string }; pricedForMultiplier: { toString(): string } };
type CircleAccount = { status: Record<string, unknown>; joinedBitmap?: number };

/**
 * Reads and decodes an Othello account through the Chain, or null if absent.
 * Through the Chain rather than program.account, so devnet and bankrun read
 * the same way (bankrun's connection throws on a missing account).
 */
async function fetchOrNull<T>(chain: Chain, name: string, address: PublicKeyT): Promise<T | null> {
  const info = await chain.getAccount(address);
  if (!info) return null;
  return chain.program.coder.accounts.decode(name, Buffer.from(info.data)) as T;
}

/**
 * Seeds the demo circle through activation. `members[0]` is the creator; the
 * member order is the turn order. Returns the circle address.
 */
export async function seedDemoCircle(chain: Chain, mints: Mints, members: KeypairT[]): Promise<PublicKeyT> {
  if (members.length !== DEMO.n) throw new Error(`the demo circle has ${DEMO.n} members, got ${members.length}`);
  const { program, admin } = chain;
  const m = methods(program);
  const creator = members[0]!;
  const a = addresses(program, mints, creator.publicKey);

  // 1. Price feed, and the pre-split prices (SPEC: 150 / 150 at 1.0).
  if (!(await chain.getAccount(a.feed))) {
    const ix = await m.initPriceFeed!()
      .accounts({ authority: admin.publicKey, program: program.programId, programData: a.programData, stockMint: mints.stock, feed: a.feed } )
      .instruction();
    await chain.send([ix], [admin]);
    chain.log(`price feed created: ${a.feed.toBase58()}`);
  }
  const feed = await fetchOrNull<Feed>(chain, "priceFeed", a.feed);
  const circleBefore = await fetchOrNull<CircleAccount>(chain, "circle", a.circle);
  // Prices are set only before the circle exists: afterwards the demo owns
  // them (the split script, touch-prices), and a re-run must not undo that.
  const demoPrices =
    feed!.wrapperPrice.toString() === String(DEMO.wrapperPrice) &&
    feed!.sharePrice.toString() === String(DEMO.sharePrice) &&
    feed!.pricedForMultiplier.toString() === DEMO.ONE_X.toString();
  if (!circleBefore && !demoPrices) {
    const ix = await m.setPrices!(new BN(DEMO.wrapperPrice), new BN(DEMO.sharePrice), { current: {} }, new BN(DEMO.ONE_X.toString()))
      .accounts({ authority: admin.publicKey, stockMint: mints.stock, feed: a.feed } )
      .instruction();
    await chain.send([ix], [admin]);
    chain.log("prices set: wrapper 150, share 150, multiplier 1.0");
  }

  // 2. Liquidation pool, seeded to POOL_SEED_USDC.
  const poolVault = ataAddress(mints.usdc, a.pool, SPL_TOKEN);
  const poolStockVault = ataAddress(mints.stock, a.pool, TOKEN_2022);
  if (!(await chain.getAccount(a.pool))) {
    const ix = await m.initPool!(DEMO.poolDiscountBps)
      .accounts({
        authority: admin.publicKey,
        program: program.programId,
        programData: a.programData,
        usdcMint: mints.usdc,
        stockMint: mints.stock,
        pool: a.pool,
        poolUsdcVault: poolVault,
        poolStockVault,
        usdcTokenProgram: SPL_TOKEN,
        stockTokenProgram: TOKEN_2022,
        associatedTokenProgram: ASSOCIATED_TOKEN,
        systemProgram: SystemProgram.programId,
      } )
      .instruction();
    await chain.send([ix], [admin]);
    chain.log(`pool created: ${a.pool.toBase58()}`);
  }
  // Seeded only before the circle exists (the pool is seeded before
  // create_circle, so a circle means this step already ran). Once the demo is
  // live, declare_default spends from the pool and a re-run must not refill it.
  const inPool = await tokenBalance(chain, poolVault);
  if (!circleBefore && inPool < POOL_SEED_USDC) {
    const adminUsdc = ataAddress(mints.usdc, admin.publicKey, SPL_TOKEN);
    const ix = await m.seedPool!(new BN((POOL_SEED_USDC - inPool).toString()))
      .accounts({
        authority: admin.publicKey,
        pool: a.pool,
        usdcMint: mints.usdc,
        stockMint: mints.stock,
        authorityUsdc: adminUsdc,
        poolUsdcVault: poolVault,
        usdcTokenProgram: SPL_TOKEN,
      } )
      .instruction();
    await chain.send([createAtaIdempotentIx(admin.publicKey, admin.publicKey, mints.usdc, SPL_TOKEN), mintToCheckedIx(mints.usdc, adminUsdc, admin.publicKey, POOL_SEED_USDC - inPool, TEST_USDC_DECIMALS, SPL_TOKEN), ix], [admin]);
    chain.log(`pool seeded to ${POOL_SEED_USDC / BigInt(USDC)} test USDC`);
  }

  // 3. Members: SOL for fees, the stock they lock, the USDC they owe. Topped
  //    up to exactly what they need, never past it.
  for (const [i, w] of members.entries()) {
    const ixs: Ix[] = [];
    // Only before joining: joining spends some of it on rent, and a re-run
    // must not read that as "under-funded" and send more.
    const joined = await chain.getAccount(a.member(w.publicKey));
    if (!joined) {
      const lamports = (await chain.getAccount(w.publicKey))?.lamports ?? 0;
      if (lamports < MEMBER_LAMPORTS) {
        ixs.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: w.publicKey, lamports: MEMBER_LAMPORTS - lamports }));
      }
      const stockAta = ataAddress(mints.stock, w.publicKey, TOKEN_2022);
      const usdcAta = ataAddress(mints.usdc, w.publicKey, SPL_TOKEN);
      const stock = await tokenBalance(chain, stockAta);
      const usdc = await tokenBalance(chain, usdcAta);
      if (stock < MEMBER_STOCK) {
        ixs.push(createAtaIdempotentIx(admin.publicKey, w.publicKey, mints.stock, TOKEN_2022));
        ixs.push(mintToCheckedIx(mints.stock, stockAta, admin.publicKey, MEMBER_STOCK - stock, NFLXX_MIRROR_DECIMALS, TOKEN_2022));
      }
      if (usdc < MEMBER_USDC) {
        ixs.push(createAtaIdempotentIx(admin.publicKey, w.publicKey, mints.usdc, SPL_TOKEN));
        ixs.push(mintToCheckedIx(mints.usdc, usdcAta, admin.publicKey, MEMBER_USDC - usdc, TEST_USDC_DECIMALS, SPL_TOKEN));
      }
    }
    if (ixs.length) {
      await chain.send(ixs, [admin]);
      chain.log(`member ${i + 1} funded: ${w.publicKey.toBase58()}`);
    }
  }

  // 4. The circle, created by member 1 with every member named in turn order.
  if (!circleBefore) {
    const ix = await m.createCircle!(
      {
        circleId: new BN(DEMO.circleId.toString()),
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
      members.map((w) => w.publicKey),
    )
      .accounts({
        creator: creator.publicKey,
        circle: a.circle,
        stockMint: mints.stock,
        usdcMint: mints.usdc,
        priceFeed: a.feed,
        pool: a.pool,
        systemProgram: SystemProgram.programId,
      } )
      .instruction();
    await chain.send([ix], [creator]);
    chain.log(`circle created: ${a.circle.toBase58()}`);
  }

  // 5. Every member joins, BEFORE any split is scheduled (join refuses during
  //    Repricing, SPEC §5).
  for (const [i, w] of members.entries()) {
    if (await chain.getAccount(a.member(w.publicKey))) continue;
    const ix = await m.joinAndLock!(new BN(DEMO.lockRaw.toString()))
      .accounts({
        wallet: w.publicKey,
        circle: a.circle,
        member: a.member(w.publicKey),
        stockMint: mints.stock,
        usdcMint: mints.usdc,
        priceFeed: a.feed,
        memberStockAta: ataAddress(mints.stock, w.publicKey, TOKEN_2022),
        memberUsdcAta: ataAddress(mints.usdc, w.publicKey, SPL_TOKEN),
        circleStockVault: ataAddress(mints.stock, a.circle, TOKEN_2022),
        circleUsdcVault: ataAddress(mints.usdc, a.circle, SPL_TOKEN),
        stockTokenProgram: TOKEN_2022,
        usdcTokenProgram: SPL_TOKEN,
        associatedTokenProgram: ASSOCIATED_TOKEN,
        systemProgram: SystemProgram.programId,
      } )
      .instruction();
    await chain.send([ix], [w]);
    chain.log(`member ${i + 1} joined and locked 1.1 NFLXx mirror`);
  }

  // 6. Activate.
  const circle = await fetchOrNull<CircleAccount>(chain, "circle", a.circle);
  if (circle && "forming" in circle.status) {
    const ix = await m.activate!().accounts({ creator: creator.publicKey, circle: a.circle } ).instruction();
    await chain.send([ix], [creator]);
    chain.log("circle activated");
  }

  return a.circle;
}

/**
 * Schedules the demo split (FR-10): the mirror's multiplier becomes 10.0 at
 * `effectiveAt`, and the feed is re-priced for it (share 150 -> 15, stamped
 * Scheduled). The circle is in Repricing from here until the effective time.
 */
export async function scheduleSplit(chain: Chain, mints: Mints, creator: PublicKeyT, effectiveAt: number): Promise<void> {
  const { program, admin } = chain;
  const now = await chain.now();
  if (effectiveAt <= now) throw new Error(`the split must be in the future: effective ${effectiveAt}, chain now ${now}`);

  // T24 adversary: a split scheduled before the seed finished re-stamped the
  // feed for 10x, and the seed's own set_prices(Current, 1x) could then never
  // pass again. SPEC.md:137: every member joins BEFORE the split. activate
  // needs every seat joined, so Active is that condition, read from the chain.
  const a = addresses(program, mints, creator);
  const circle = await fetchOrNull<CircleAccount>(chain, "circle", a.circle);
  if (!circle || !("active" in circle.status)) {
    throw new Error(`the demo circle ${a.circle.toBase58()} is not Active: finish the seed (every member joined, activated) before scheduling the split`);
  }
  const feedState = await fetchOrNull<Feed>(chain, "priceFeed", a.feed);
  if (feedState && feedState.pricedForMultiplier.toString() !== DEMO.ONE_X.toString()) {
    throw new Error("the feed is already priced for the split: it has been scheduled once already");
  }

  const feed = a.feed;
  const reprice = await methods(program)
    .setPrices!(new BN(DEMO.wrapperPrice), new BN(DEMO.splitSharePrice), { scheduled: {} }, new BN(DEMO.TEN_X.toString()))
    .accounts({ authority: admin.publicKey, stockMint: mints.stock, feed } )
    .instruction();
  // One transaction: the multiplier is never scheduled without the price that
  // matches it, which is the epoch mismatch SPEC's price stamp exists to stop.
  await chain.send([updateMultiplierIx(mints.stock, admin.publicKey, DEMO.splitMultiplier, BigInt(effectiveAt)), reprice], [admin]);
  chain.log(`split scheduled: x${DEMO.splitMultiplier} at ${new Date(effectiveAt * 1000).toISOString()}, share re-priced 150 -> 15`);
}


type RoundCircle = {
  status: Record<string, unknown>;
  round: number;
  n: number;
  members: PublicKeyT[];
  paidBitmap: number;
  defaultedBitmap: number;
  receivedBitmap: number;
};

/**
 * The demo's rounds, played by the script-held members (T25). Pays this
 * round's contribution for every seat that has not paid and is not in `skip`
 * (0-based turns: the seat Joshua pays himself, on camera, from the app).
 * Each member signs their own payment. Returns the turns it paid for.
 */
export async function payRound(chain: Chain, mints: Mints, members: KeypairT[], skip: number[] = []): Promise<number[]> {
  const creator = members[0]!;
  const a = addresses(chain.program, mints, creator.publicKey);
  const c = await fetchOrNull<RoundCircle>(chain, "circle", a.circle);
  if (!c || !("active" in c.status)) throw new Error(`the demo circle ${a.circle.toBase58()} is not Active`);

  const paid: number[] = [];
  for (const [turn, w] of members.entries()) {
    if (skip.includes(turn)) continue;
    if (c.paidBitmap & (1 << turn) || c.defaultedBitmap & (1 << turn)) continue;
    if (!c.members[turn]!.equals(w.publicKey)) throw new Error(`seat ${turn + 1}'s key is not the circle's member ${c.members[turn]!.toBase58()}`);
    const ix = await methods(chain.program)
      .contribute!()
      .accounts({
        wallet: w.publicKey,
        circle: a.circle,
        member: a.member(w.publicKey),
        usdcMint: mints.usdc,
        memberUsdcAta: ataAddress(mints.usdc, w.publicKey, SPL_TOKEN),
        circleUsdcVault: ataAddress(mints.usdc, a.circle, SPL_TOKEN),
        usdcTokenProgram: SPL_TOKEN,
      })
      .instruction();
    await chain.send([ix], [w]);
    chain.log(`seat ${turn + 1} paid round ${c.round + 1}`);
    paid.push(turn);
  }
  return paid;
}

/**
 * Releases this round's pot to its recipient (release_pot: anyone may call,
 * the admin pays the fee). Refuses, with the missing seats, if the round is not
 * funded, rather than sending a transaction the program would refuse anyway.
 */
export async function releasePot(chain: Chain, mints: Mints, creator: PublicKeyT): Promise<void> {
  const a = addresses(chain.program, mints, creator);
  const c = await fetchOrNull<RoundCircle>(chain, "circle", a.circle);
  if (!c || !("active" in c.status)) throw new Error(`the demo circle ${a.circle.toBase58()} is not Active`);
  const missing = Array.from({ length: c.n }, (_, t) => t).filter((t) => !(c.paidBitmap & (1 << t)) && !(c.defaultedBitmap & (1 << t)));
  if (missing.length) throw new Error(`round ${c.round + 1} is not funded: seat(s) ${missing.map((t) => t + 1).join(", ")} have not paid`);

  const recipient = c.members[c.round]!;
  const ix = await methods(chain.program)
    .releasePot!()
    .accounts({
      caller: chain.admin.publicKey,
      circle: a.circle,
      stockMint: mints.stock,
      usdcMint: mints.usdc,
      priceFeed: a.feed,
      recipient,
      recipientUsdcAta: ataAddress(mints.usdc, recipient, SPL_TOKEN),
      circleUsdcVault: ataAddress(mints.usdc, a.circle, SPL_TOKEN),
      usdcTokenProgram: SPL_TOKEN,
      associatedTokenProgram: ASSOCIATED_TOKEN,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  // Every Member account, writable, in turn order (SPEC §5).
  ix.keys.push(...c.members.slice(0, c.n).map((w) => ({ pubkey: a.member(w), isSigner: false, isWritable: true })));
  await chain.send([ix], [chain.admin]);
  chain.log(`round ${c.round + 1}'s pot released to seat ${c.round + 1} (${recipient.toBase58()})`);
}
