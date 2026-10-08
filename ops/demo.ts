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

type Addresses = ReturnType<typeof addresses>;

/**
 * What the admin sends a seat's wallet before it joins: SOL for fees and rent, the stock it locks, the USDC it owes.
 * Topped up to exactly that, never past it, and nothing once the seat has joined (joining spends some of it on rent,
 * and a re-run must not read that as "under-funded" and send more).
 */
async function fundingIxs(chain: Chain, mints: Mints, a: Addresses, wallet: PublicKeyT): Promise<Ix[]> {
  const { admin } = chain;
  const ixs: Ix[] = [];
  if (await chain.getAccount(a.member(wallet))) return ixs;
  const lamports = (await chain.getAccount(wallet))?.lamports ?? 0;
  if (lamports < MEMBER_LAMPORTS) {
    ixs.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wallet, lamports: MEMBER_LAMPORTS - lamports }));
  }
  const stockAta = ataAddress(mints.stock, wallet, TOKEN_2022);
  const usdcAta = ataAddress(mints.usdc, wallet, SPL_TOKEN);
  const stock = await tokenBalance(chain, stockAta);
  const usdc = await tokenBalance(chain, usdcAta);
  if (stock < MEMBER_STOCK) {
    ixs.push(createAtaIdempotentIx(admin.publicKey, wallet, mints.stock, TOKEN_2022));
    ixs.push(mintToCheckedIx(mints.stock, stockAta, admin.publicKey, MEMBER_STOCK - stock, NFLXX_MIRROR_DECIMALS, TOKEN_2022));
  }
  if (usdc < MEMBER_USDC) {
    ixs.push(createAtaIdempotentIx(admin.publicKey, wallet, mints.usdc, SPL_TOKEN));
    ixs.push(mintToCheckedIx(mints.usdc, usdcAta, admin.publicKey, MEMBER_USDC - usdc, TEST_USDC_DECIMALS, SPL_TOKEN));
  }
  return ixs;
}

/** create_circle with SPEC's demo parameters, the members named in turn order. */
async function createCircleIx(program: anchor.Program<anchor.Idl>, mints: Mints, a: Addresses, creator: PublicKeyT, members: PublicKeyT[]): Promise<Ix> {
  return methods(program)
    .createCircle!(
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
      members,
    )
    .accounts({
      creator,
      circle: a.circle,
      stockMint: mints.stock,
      usdcMint: mints.usdc,
      priceFeed: a.feed,
      pool: a.pool,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** join_and_lock of the demo's 1.1 token for `wallet`. */
async function joinIx(program: anchor.Program<anchor.Idl>, mints: Mints, a: Addresses, wallet: PublicKeyT): Promise<Ix> {
  return methods(program)
    .joinAndLock!(new BN(DEMO.lockRaw.toString()))
    .accounts({
      wallet,
      circle: a.circle,
      member: a.member(wallet),
      stockMint: mints.stock,
      usdcMint: mints.usdc,
      priceFeed: a.feed,
      memberStockAta: ataAddress(mints.stock, wallet, TOKEN_2022),
      memberUsdcAta: ataAddress(mints.usdc, wallet, SPL_TOKEN),
      circleStockVault: ataAddress(mints.stock, a.circle, TOKEN_2022),
      circleUsdcVault: ataAddress(mints.usdc, a.circle, SPL_TOKEN),
      stockTokenProgram: TOKEN_2022,
      usdcTokenProgram: SPL_TOKEN,
      associatedTokenProgram: ASSOCIATED_TOKEN,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * Seeds the demo circle through activation. `members[0]` is the creator; the
 * member order is the turn order. Returns the circle address.
 *
 * `joined` (tests of the forming circle's own steps): only those seats, by turn, join, and the circle is left
 * Forming. Omitted: every seat joins and the circle is activated, as before.
 */
export async function seedDemoCircle(chain: Chain, mints: Mints, members: KeypairT[], joined?: number[]): Promise<PublicKeyT> {
  if (members.length !== DEMO.n) throw new Error(`the demo circle has ${DEMO.n} members, got ${members.length}`);
  const { program, admin } = chain;
  const m = methods(program);
  const creator = members[0]!;
  const a = addresses(program, mints, creator.publicKey);

  // 0. Codex T18 r1: check everything that already exists BEFORE sending
  //    anything. A seed with the wrong member keys used to fund them (and,
  //    with another creator, start a second circle); an existing pool with
  //    another discount was accepted as the SPEC demo's.
  const existingCircle = await fetchOrNull<{ n: number; members: PublicKeyT[] }>(chain, "circle", a.circle);
  if (existingCircle) {
    const named = existingCircle.members.slice(0, existingCircle.n);
    if (named.length !== members.length || named.some((k, i) => !k.equals(members[i]!.publicKey))) {
      throw new Error(`the demo circle ${a.circle.toBase58()} exists and its members are not these keys. Nothing was sent.`);
    }
  }
  const existingPool = await fetchOrNull<{ authority: PublicKeyT; discountBps: number }>(chain, "liquidationPool", a.pool);
  if (existingPool && (!existingPool.authority.equals(admin.publicKey) || existingPool.discountBps !== DEMO.poolDiscountBps)) {
    throw new Error(
      `the pool ${a.pool.toBase58()} exists with authority ${existingPool.authority.toBase58()} and discount ${existingPool.discountBps} bps, ` +
        `not this admin at the demo's ${DEMO.poolDiscountBps}. Nothing was sent.`,
    );
  }
  const existingFeed = await fetchOrNull<{ authority: PublicKeyT }>(chain, "priceFeed", a.feed);
  if (existingFeed && !existingFeed.authority.equals(admin.publicKey)) {
    throw new Error(`the price feed ${a.feed.toBase58()} belongs to ${existingFeed.authority.toBase58()}, not this admin. Nothing was sent.`);
  }

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
    const ixs = await fundingIxs(chain, mints, a, w.publicKey);
    if (ixs.length) {
      await chain.send(ixs, [admin]);
      chain.log(`member ${i + 1} funded: ${w.publicKey.toBase58()}`);
    }
  }

  // 4. The circle, created by member 1 with every member named in turn order.
  if (!circleBefore) {
    await chain.send([await createCircleIx(program, mints, a, creator.publicKey, members.map((w) => w.publicKey))], [creator]);
    chain.log(`circle created: ${a.circle.toBase58()}`);
  }

  // 5. Every member joins, BEFORE any split is scheduled (join refuses during
  //    Repricing, SPEC §5).
  for (const [i, w] of members.entries()) {
    if (joined && !joined.includes(i)) continue;
    if (await chain.getAccount(a.member(w.publicKey))) continue;
    const ix = await joinIx(program, mints, a, w.publicKey);
    await chain.send([ix], [w]);
    chain.log(`member ${i + 1} joined and locked 1.1 NFLXx mirror`);
  }

  // 6. Activate.
  if (joined) return a.circle;
  const circle = await fetchOrNull<CircleAccount>(chain, "circle", a.circle);
  if (circle && "forming" in circle.status) {
    const ix = await m.activate!().accounts({ creator: creator.publicKey, circle: a.circle } ).instruction();
    await chain.send([ix], [creator]);
    chain.log("circle activated");
  }

  return a.circle;
}

/**
 * SPEC.md:137 / TASKS T26: keeps the demo's price fresh. Calls touch_prices ONLY, which moves the feed's updated_at to
 * the chain's now and nothing else (I17: prices and stamp untouched), so it can never re-bind a price to another
 * multiplier. Returns the feed's updated_at before and after.
 */
export async function touchPrices(chain: Chain, mints: Mints): Promise<{ before: number; after: number }> {
  const { program, admin } = chain;
  const feed = addresses(program, mints, admin.publicKey).feed;
  const read = () => fetchOrNull<{ authority: PublicKeyT; updatedAt: { toString(): string } }>(chain, "priceFeed", feed);
  const was = await read();
  if (!was) throw new Error(`there is no price feed at ${feed.toBase58()} for ${mints.stock.toBase58()}. Nothing was sent.`);
  if (!was.authority.equals(admin.publicKey)) {
    throw new Error(`the price feed ${feed.toBase58()} belongs to ${was.authority.toBase58()}, not this admin. Nothing was sent.`);
  }
  const ix = await methods(program).touchPrices!().accounts({ authority: admin.publicKey, feed }).instruction();
  await chain.send([ix], [admin]);
  const now = await read();
  const before = Number(was.updatedAt.toString());
  const after = Number(now!.updatedAt.toString());
  chain.log(`price refreshed: updated_at ${new Date(before * 1000).toISOString()} -> ${new Date(after * 1000).toISOString()}`);
  return { before, after };
}

/** A try circle is refused unless its price stays fresh this long after the check: the joins that follow need it. */
export const TRY_PRICE_MARGIN_SECS = 3600;

/**
 * A forming circle for trying the app's join and leave from a real wallet (PR #29's devnet try). SPEC's demo
 * parameters; `scripted` (n - 1 script-held keys) take seats 1 to n - 1, `scripted[0]` creates it, and each joins;
 * seat n is `wallet`, funded like every seat (0.02 SOL, 1.1 NFLXx mirror, the test USDC it owes) and left open. The
 * circle stays Forming.
 *
 * Never creates or changes the price feed or the pool: it uses the demo's, as they are. So it cannot disturb the
 * demo circle. Every step checks the chain first, so a stopped run is finished by running it again.
 */
/**
 * Where a try seed records which seats it is for (ops/try-circle.json on devnet; memory in tests). PR #30 Codex r1:
 * the record is written BEFORE the first send, so a run that stops after funding a wallet binds every rerun to that
 * same wallet, whether or not the circle exists yet.
 */
export type TrySeatsRecord = { read(): string[] | null; write(seats: string[]): void };

/** A TrySeatsRecord held in memory: the bankrun specs' stand-in for ops/try-circle.json. */
export function memoryTryRecord(): TrySeatsRecord {
  let seats: string[] | null = null;
  return { read: () => seats, write: (s) => void (seats = s) };
}

export async function seedTryCircle(
  chain: Chain,
  mints: Mints,
  scripted: KeypairT[],
  wallet: PublicKeyT,
  record: TrySeatsRecord,
): Promise<PublicKeyT> {
  const { program, admin } = chain;
  if (scripted.length !== DEMO.n - 1) throw new Error(`a try circle has ${DEMO.n - 1} script-held seats, got ${scripted.length}`);
  if (!PublicKey.isOnCurve(wallet.toBytes())) throw new Error(`${wallet.toBase58()} is not a wallet address (it cannot sign). Nothing was sent.`);
  if (wallet.equals(admin.publicKey) || scripted.some((k) => k.publicKey.equals(wallet))) {
    throw new Error(`${wallet.toBase58()} is the admin or a script-held key: the try seat must be your own wallet. Nothing was sent.`);
  }
  const creator = scripted[0]!;
  const seats = [...scripted.map((k) => k.publicKey), wallet];
  const a = addresses(program, mints, creator.publicKey);

  // Everything checked before anything is sent.
  const existing = await fetchOrNull<{ n: number; members: PublicKeyT[]; status: Record<string, unknown> }>(chain, "circle", a.circle);
  if (existing) {
    const named = existing.members.slice(0, existing.n);
    if (named.length !== seats.length || named.some((k, i) => !k.equals(seats[i]!))) {
      throw new Error(`the try circle ${a.circle.toBase58()} exists and its seats are not these keys and this wallet. Nothing was sent.`);
    }
    if (!("forming" in existing.status)) {
      throw new Error(`the try circle ${a.circle.toBase58()} is no longer Forming (${Object.keys(existing.status)[0]}). Nothing was sent.`);
    }
  }
  const pool = await fetchOrNull<{ authority: PublicKeyT }>(chain, "liquidationPool", a.pool);
  if (!pool || !pool.authority.equals(admin.publicKey)) {
    throw new Error(`the demo's pool ${a.pool.toBase58()} is missing or not this admin's: seed the demo circle first. Nothing was sent.`);
  }
  const feed = await fetchOrNull<{ authority: PublicKeyT; updatedAt: { toString(): string } }>(chain, "priceFeed", a.feed);
  if (!feed || !feed.authority.equals(admin.publicKey)) {
    throw new Error(`the demo's price feed ${a.feed.toBase58()} is missing or not this admin's: seed the demo circle first. Nothing was sent.`);
  }
  const age = (await chain.now()) - Number(feed.updatedAt.toString());
  if (age + TRY_PRICE_MARGIN_SECS > DEMO.maxPriceAge) {
    throw new Error(
      `the price is ${Math.floor(age / 3600)} h old and a circle takes it up to ${DEMO.maxPriceAge / 3600} h: run ops/touch-prices.ts first. Nothing was sent.`,
    );
  }

  // The last no-send check, and then the first write: the seats this seed is for, recorded before anything is sent.
  const recorded = record.read();
  const names = seats.map((k) => k.toBase58());
  if (recorded && (recorded.length !== names.length || recorded.some((k, i) => k !== names[i]))) {
    throw new Error(
      `the try seed is recorded for wallet ${recorded[recorded.length - 1]} (seats ${recorded.join(", ")}), not ${wallet.toBase58()}. Nothing was sent.`,
    );
  }
  if (!recorded) record.write(names);

  // Seats: the script-held keys and the wallet, each funded the same way, and only before the circle exists. Funding
  // comes first, so a circle on chain means every seat was funded. After that a seat's balance is its own: the wallet's
  // join and leave fees leave it under MEMBER_LAMPORTS, and a re-run must not top it up (PR #30 adversary).
  for (const [i, w] of existing ? [] : seats.entries()) {
    const ixs = await fundingIxs(chain, mints, a, w);
    if (ixs.length) {
      await chain.send(ixs, [admin]);
      chain.log(`seat ${i + 1} funded: ${w.toBase58()}${i === seats.length - 1 ? " (your wallet)" : ""}`);
    }
  }
  if (!existing) {
    await chain.send([await createCircleIx(program, mints, a, creator.publicKey, seats)], [creator]);
    chain.log(`try circle created: ${a.circle.toBase58()}`);
  }
  for (const [i, k] of scripted.entries()) {
    if (await chain.getAccount(a.member(k.publicKey))) continue;
    await chain.send([await joinIx(program, mints, a, k.publicKey)], [k]);
    chain.log(`seat ${i + 1} joined and locked 1.1 NFLXx mirror`);
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
