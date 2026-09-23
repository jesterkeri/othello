/**
 * T10-T12 adversary pass: the attacks the three gate-2 suites do not run.
 *
 * Every case here PASSES against 48cf887. This is coverage the suite was
 * missing, not a defect. What it adds, in the order the cases appear:
 *
 *  1. The gate AT ONE BASE UNIT. The T10 suite moves the price in whole
 *     dollars, so a gate that floored `ceil(O x coverage_bps / 10000)` instead
 *     of ceiling it, or compared with `<` instead of `<=`, would survive it.
 *     The two cases here sit either side of the exact base unit where
 *     `need_r == reserve_total - reserve_losses`, so one of them fails for
 *     either mutation.
 *
 *  2. A DIFFERENTIAL sweep of the gate against SPEC section 4 and section 5
 *     re-implemented here, over sixteen prices, with parameters chosen so that
 *     both the obligation ceil and the collateral floor have a remainder. I2,
 *     I3 and I4 are asserted after every instruction in the sweep, including
 *     after a refusal, where the interesting question is that NOTHING moved.
 *
 *  3. n = 8, the maximum. The gate suites only run n = 5, and n = 8 is where
 *     every bitmap is full, where `1u8 << n` would overflow, and where NFR-3's
 *     200k compute budget is tightest: release_pot values all eight positions
 *     against the real mint in one instruction.
 *
 *  4. release_pot and update_coverage ACROSS THE REAL NFLXx SPLIT. T10-T12 all
 *     run at BEFORE_SPLIT, so the demo's own headline, a payout that survives a
 *     10-for-1, is untested against the instructions that pay it.
 *
 *  5. A recipient who has CLOSED their USDC account. SPEC.md:106 promises
 *     `init_if_needed` with the caller as payer; a member with a zero balance
 *     really can close an SPL account, and if this failed their pot could never
 *     be released.
 *
 *  6. Two withdraws, and two release_pots, inside ONE transaction. The suites
 *     use h.nextSlot() to separate a repeat into a second transaction, which is
 *     the right fix for the "already processed" trap but leaves the same-
 *     transaction case, where the runtime is no help, unasserted.
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
  SCHEDULED,
  SPLIT_AT,
  SPL_TOKEN_PROGRAM,
  TEN_X,
  TOKEN_2022_PROGRAM,
  ataAddress,
  call,
  circleAddress,
  fetchAccount,
  harness,
  initFeed,
  poolAddress,
  priceFeedAddress,
  send,
  setPrices,
  splMintAccount,
  tokenAccount,
  tokenAmount,
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000;

type Params = {
  contribution: number;
  roundSecs: number;
  graceSecs: number;
  haircutBps: number;
  coverageBps: number;
  warnBps: number;
  guaranteePerMember: number;
  minStockCover: number;
  maxPriceAge: number;
};

/** SPEC.md:134's demo circle. */
const DEMO: Params = {
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

/**
 * The same shape at n = 8. SPEC.md:130's peak for these parameters is 615 USDC
 * at k = 3, so 8 x 77 is the smallest whole-USDC guarantee that clears it.
 */
const DEMO_8: Params = { ...DEMO, guaranteePerMember: 77 * USDC };

/**
 * Deliberately not round numbers. `4c x 13333 / 10000` is 177_773_331.5556, so
 * the obligation ceil and the collateral floor both have a remainder, and
 * haircut 0 with exactly one whole token makes the counted value equal the
 * price, which is what lets the boundary below be named to the base unit.
 */
const FRACTIONAL: Params = {
  ...DEMO,
  contribution: 33_333_333,
  haircutBps: 0,
  coverageBps: 13_333,
};

/** SPEC section 4: prices are per one whole (10^8 raw) token. */
const ONE_TOKEN = 100_000_000n;
const DEMO_LOCK = 110_000_000n;
const START_PRICE = 150 * USDC;

/** R = n x g for the fractional circle, and the price where need_r equals it. */
const FRACTIONAL_RESERVE = FRACTIONAL.guaranteePerMember * 5;
const REQUIRED_CEIL = 177_773_332;
const EXACT_PRICE = REQUIRED_CEIL - FRACTIONAL_RESERVE;

/** NFR-3: every instruction fits the default budget with n = 8. */
const DEFAULT_COMPUTE_BUDGET = 200_000n;

type CircleState = {
  status: Record<string, unknown>;
  round: number;
  receivedBitmap: number;
  reserveTotal: { toNumber(): number };
  reserveLosses: { toNumber(): number };
  reserveAllocated: { toNumber(): number };
  escrow: { toNumber(): number };
  heldContributions: { toNumber(): number };
  withdrawnUsdc: { toNumber(): number };
  nextGateShortBy: { toNumber(): number };
};

type MemberState = {
  turn: number;
  roundsPaid: number;
  stockRaw: { toString(): string };
  allocated: { toNumber(): number };
  lastCoverageBps: number;
};

/** SPEC section 4, re-implemented rather than read from the program. */
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function countedValue(raw: bigint, share: bigint, wrapper: bigint, haircutBps: bigint) {
  const fund = (raw * BigInt(ONE_X) * share) / (1_000_000_000n * 100_000_000n);
  const exec = (raw * wrapper) / 100_000_000n;
  const lower = fund < exec ? fund : exec;
  return (lower * (10_000n - haircutBps)) / 10_000n;
}

function needOf(obligations: bigint, cover: bigint, coverageBps: bigint) {
  if (obligations === 0n) return 0n;
  const required = ceilDiv(obligations * coverageBps, 10_000n);
  return required > cover ? required - cover : 0n;
}

describe("T10-T12 adversary", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let creator: anchor.web3.Keypair;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;
  let params: Params;
  let n: number;

  const memberAddress = (wallet: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), wallet.toBuffer()],
      h.program.programId,
    )[0];

  const readCircle = () => fetchAccount<CircleState>(h.program, "circle", circle);
  const readMember = (w: anchor.web3.PublicKey) =>
    fetchAccount<MemberState>(h.program, "member", memberAddress(w));

  const amountAt = async (address: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(address);
    return info && info.data.length > 0 ? tokenAmount(Buffer.from(info.data)) : null;
  };

  /** Writes a token account back as a system account: what closing one leaves. */
  const closeAccount = (address: anchor.web3.PublicKey) =>
    h.context.setAccount(address, {
      lamports: 0,
      data: Buffer.alloc(0),
      owner: anchor.web3.SystemProgram.programId,
      executable: false,
    });

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

  const releaseBuilder = (caller: anchor.web3.Keypair, recipient: anchor.web3.PublicKey) =>
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
      .signers([caller]);

  const release = (caller: anchor.web3.Keypair, recipient: anchor.web3.PublicKey) =>
    releaseBuilder(caller, recipient).rpc();

  const updateCoverageBuilder = (caller: anchor.web3.Keypair) =>
    call(h.program, "updateCoverage", [])
      .accounts({
        caller: caller.publicKey,
        circle,
        stockMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
      })
      .remainingAccounts(memberMetas())
      .signers([caller]);

  const withdrawBuilder = (wallet: anchor.web3.Keypair) =>
    call(h.program, "withdraw", [])
      .accounts({
        wallet: wallet.publicKey,
        circle,
        member: memberAddress(wallet.publicKey),
        stockMint,
        usdcMint,
        memberStockAta: ataAddress(stockMint, wallet.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, wallet.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet]);

  const reprice = (price: number) =>
    setPrices(h, stockMint, {
      wrapper: price,
      share: price,
      stamp: CURRENT,
      expected: ONE_X,
    });

  /** A fresh bank, a fresh circle, everyone joined and the circle Active. */
  async function setUp(seats: number, p: Params, lock: bigint) {
    n = seats;
    params = p;

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
        // SPEC.md:128: pool.discount_bps <= haircut_bps, so H never exceeds
        // what liquidation would return.
        discountBps: p.haircutBps,
      }),
      h.program.programId,
    );

    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, {
      wrapper: START_PRICE,
      share: START_PRICE,
      stamp: CURRENT,
      expected: ONE_X,
    });

    creator = h.fund(100 * anchor.web3.LAMPORTS_PER_SOL);
    wallets = [
      creator,
      ...Array.from({ length: seats - 1 }, () => h.fund(100 * anchor.web3.LAMPORTS_PER_SOL)),
    ];

    circle = circleAddress(h.program, creator.publicKey, 0n);

    await call(h.program, "createCircle", [
      {
        circleId: new BN(0),
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
      fundWallet(
        w.publicKey,
        lock * 2n,
        BigInt(p.guaranteePerMember + p.contribution * seats * 2),
      );
    }
    for (const w of wallets) await join(w, lock);
    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();
  }

  /** I2, I3 and I4, read off the tokens rather than off the program's word. */
  async function assertBooks(where: string) {
    const c = await readCircle();

    const expectedUsdc =
      BigInt(c.reserveTotal.toNumber()) -
      BigInt(c.reserveLosses.toNumber()) +
      BigInt(c.escrow.toNumber()) +
      BigInt(c.heldContributions.toNumber()) -
      BigInt(c.withdrawnUsdc.toNumber());
    assert.equal(
      (await amountAt(ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM))) ?? 0n,
      expectedUsdc,
      `I3 at ${where}`,
    );

    let stock = 0n;
    let allocated = 0n;
    for (const w of wallets) {
      const m = await readMember(w.publicKey);
      stock += BigInt(m.stockRaw.toString());
      allocated += BigInt(m.allocated.toNumber());
    }
    assert.equal(
      (await amountAt(ataAddress(stockMint, circle, TOKEN_2022_PROGRAM))) ?? 0n,
      stock,
      `I4 at ${where}`,
    );
    assert.equal(allocated, BigInt(c.reserveAllocated.toNumber()), `I2 sum at ${where}`);
    assert.ok(
      BigInt(c.reserveAllocated.toNumber()) <=
        BigInt(c.reserveTotal.toNumber()) - BigInt(c.reserveLosses.toNumber()),
      `I2 cap at ${where}`,
    );
  }

  /** SPEC section 5's payout gate, computed here, not read from the program. */
  async function predictGate(price: bigint) {
    const c = await readCircle();
    let needed = 0n;
    let recipientGap = 0n;
    let recipientCover = 0n;

    for (const w of wallets) {
      const m = await readMember(w.publicKey);
      // SPEC's gate treats the recipient as received, because after the payout
      // they are.
      const received = (c.receivedBitmap & (1 << m.turn)) !== 0 || m.turn === c.round;
      const cover = countedValue(
        BigInt(m.stockRaw.toString()),
        price,
        price,
        BigInt(params.haircutBps),
      );
      const o = received
        ? BigInt(params.contribution) * BigInt(Math.max(0, n - m.roundsPaid))
        : 0n;
      const need = needOf(o, cover, BigInt(params.coverageBps));

      if (received) needed += need;
      if (m.turn === c.round) {
        recipientGap = need;
        recipientCover = cover;
      }
    }

    const remaining = BigInt(c.reserveTotal.toNumber()) - BigInt(c.reserveLosses.toNumber());

    return {
      needed,
      remaining,
      passes: needed <= remaining,
      // SPEC.md:123's conjunction.
      code:
        recipientCover < BigInt(params.minStockCover) && needed - recipientGap <= remaining
          ? "CoverageTooLow"
          : "ReserveOvercommitted",
    };
  }

  async function fundTheRound() {
    for (const w of wallets) await contribute(w);
  }

  it(`pays when the need is EXACTLY the reserve (cover ${EXACT_PRICE})`, async () => {
    await setUp(5, FRACTIONAL, ONE_TOKEN);
    await fundTheRound();
    await reprice(EXACT_PRICE);

    const before = (await amountAt(ataAddress(usdcMint, wallets[0]!.publicKey, SPL_TOKEN_PROGRAM)))!;
    await release(creator, wallets[0]!.publicKey);
    const after = (await amountAt(ataAddress(usdcMint, wallets[0]!.publicKey, SPL_TOKEN_PROGRAM)))!;

    assert.equal(after - before, BigInt(FRACTIONAL.contribution * 5), "the pot was paid");
    assert.equal(
      (await readCircle()).reserveAllocated.toNumber(),
      FRACTIONAL_RESERVE,
      "the whole reserve was allocated, to the base unit: the comparison is <=",
    );
    await assertBooks("the exact gate");
  });

  it(`refuses ONE BASE UNIT lower (cover ${EXACT_PRICE - 1})`, async () => {
    await setUp(5, FRACTIONAL, ONE_TOKEN);
    await fundTheRound();
    await reprice(EXACT_PRICE - 1);

    // A gate that floored the requirement would read 177_773_331 here, land on
    // exactly the reserve, and pay.
    assert.equal(
      await h.refusal(release(creator, wallets[0]!.publicKey)),
      "CoverageTooLow",
      "one base unit of cover short is short: the requirement ceils",
    );

    const c = await readCircle();
    assert.equal(c.receivedBitmap, 0, "no payout was recorded");
    assert.equal(
      c.heldContributions.toNumber(),
      FRACTIONAL.contribution * 5,
      "the round is still funded and still held",
    );
    await assertBooks("the refused gate");
  });

  it("the gate agrees with SPEC at every price on the way down", async () => {
    // Every division in this circle has a remainder, so a rounding rule that
    // went the member's way would show up as a disagreement rather than as a
    // number that happened to divide.
    for (const dollars of [150, 120, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 7, 5, 3, 1]) {
      await setUp(5, FRACTIONAL, ONE_TOKEN);
      const price = BigInt(dollars * USDC);

      await fundTheRound();
      await assertBooks(`contributions at ${dollars}`);
      await reprice(Number(price));

      const predicted = await predictGate(price);

      if (predicted.passes) {
        await release(creator, wallets[0]!.publicKey);
        assert.equal(
          BigInt((await readCircle()).reserveAllocated.toNumber()),
          predicted.needed,
          `reserve_allocated at ${dollars}`,
        );
      } else {
        assert.equal(
          await h.refusal(release(creator, wallets[0]!.publicKey)),
          predicted.code,
          `refusal code at ${dollars}`,
        );
      }
      await assertBooks(`the gate at ${dollars}`);

      // update_coverage caps where the gate compares, so run it at the same
      // price and check it cannot hand out more than the circle holds.
      await updateCoverageBuilder(creator).rpc();
      await assertBooks(`update_coverage at ${dollars}`);
    }
  });

  it("NFR-3: release_pot and update_coverage fit the default budget at n = 8", async () => {
    await setUp(8, DEMO_8, DEMO_LOCK);
    await fundTheRound();

    const coverage = await send(h, await updateCoverageBuilder(creator).instruction(), creator);
    assert.ok(
      coverage.computeUnitsConsumed < DEFAULT_COMPUTE_BUDGET,
      `update_coverage used ${coverage.computeUnitsConsumed} CU at n = 8`,
    );

    const released = await send(
      h,
      await releaseBuilder(creator, wallets[0]!.publicKey).instruction(),
      creator,
    );
    assert.ok(
      released.computeUnitsConsumed < DEFAULT_COMPUTE_BUDGET,
      `release_pot used ${released.computeUnitsConsumed} CU at n = 8`,
    );

    // The two projections of next_gate_short_by, one in release_pot and one in
    // update_coverage, have to be the same number for I18 to mean anything.
    const afterRelease = (await readCircle()).nextGateShortBy.toNumber();
    await updateCoverageBuilder(creator).rpc();
    assert.equal(
      (await readCircle()).nextGateShortBy.toNumber(),
      afterRelease,
      "release_pot and update_coverage must project the same next gate",
    );
  });

  it("I10 at the maximum seat count: eight payouts, then Completed, then withdrawn", async () => {
    await setUp(8, DEMO_8, DEMO_LOCK);

    const seen: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      await fundTheRound();
      await release(creator, wallets[round]!.publicKey);
      const c = await readCircle();
      seen.push(c.receivedBitmap);
      assert.equal(c.nextGateShortBy.toNumber(), 0, `I18: round ${round} left nothing Paused`);
      await assertBooks(`round ${round} at n = 8`);
    }

    assert.deepEqual(
      seen,
      [0b1, 0b11, 0b111, 0b1111, 0b11111, 0b111111, 0b1111111, 0b11111111],
      "one new bit per round, in turn order, with no bit above n - 1 ever set",
    );
    assert.ok("completed" in (await readCircle()).status);

    for (const w of wallets) await withdrawBuilder(w).rpc();
    await assertBooks("every withdrawal at n = 8");
    assert.equal(
      (await amountAt(ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM))) ?? 0n,
      0n,
      "I11: the vault is empty and nothing was paid twice",
    );
  });

  it("releases across the real NFLXx split, and refuses while it reprices", async () => {
    await setUp(5, DEMO, DEMO_LOCK);
    await fundTheRound();
    await release(creator, wallets[0]!.publicKey);

    const before = (await readMember(wallets[0]!.publicKey)).lastCoverageBps;

    // SPEC.md:134's demo: the wrapper price of a raw token is unchanged, the
    // share price falls by the multiplier, and the stamp names the scheduled
    // one. NFLXx's real split is 10-for-1 at SPLIT_AT.
    await setPrices(h, stockMint, {
      wrapper: START_PRICE,
      share: 15 * USDC,
      stamp: SCHEDULED,
      expected: TEN_X,
    });

    await fundTheRound();
    assert.equal(
      await h.refusal(release(creator, wallets[1]!.publicKey)),
      "MultiplierPriceMismatch",
      "I13: payouts wait while the price and the split disagree",
    );
    assert.equal(
      await h.refusal(updateCoverageBuilder(creator).rpc()),
      "MultiplierPriceMismatch",
      "I13: so does the recheck",
    );
    await assertBooks("Repricing");

    await h.setClock(SPLIT_AT);
    await release(creator, wallets[1]!.publicKey);

    assert.equal(
      (await readMember(wallets[0]!.publicKey)).lastCoverageBps,
      before,
      "I12: ten times the units at a tenth the share price is the same cover",
    );
    const c = await readCircle();
    assert.equal(c.round, 2, "the round advanced across the split");
    assert.equal(c.nextGateShortBy.toNumber(), 0, "I18: no Paused after a healthy payout");
    await assertBooks("after the split");
  });

  it("pays a recipient who has closed their USDC account", async () => {
    await setUp(5, DEMO, DEMO_LOCK);
    await fundTheRound();

    const recipient = wallets[0]!.publicKey;
    closeAccount(ataAddress(usdcMint, recipient, SPL_TOKEN_PROGRAM));
    assert.equal(
      await amountAt(ataAddress(usdcMint, recipient, SPL_TOKEN_PROGRAM)),
      null,
      "the account is gone",
    );

    // SPEC.md:106: the caller pays to recreate it, so a member who closed an
    // account cannot make their own pot unreleasable.
    await release(wallets[3]!, recipient);

    assert.equal(
      await amountAt(ataAddress(usdcMint, recipient, SPL_TOKEN_PROGRAM)),
      BigInt(DEMO.contribution * 5),
      "the pot landed in the account the caller paid for",
    );
  });

  it("returns stock and guarantee to accounts the member had closed", async () => {
    await setUp(5, DEMO, DEMO_LOCK);
    for (let round = 0; round < 5; round += 1) {
      await fundTheRound();
      await release(creator, wallets[round]!.publicKey);
    }

    const w = wallets[2]!;
    closeAccount(ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM));
    closeAccount(ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM));

    await withdrawBuilder(w).rpc();

    assert.equal(
      await amountAt(ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM)),
      DEMO_LOCK,
      "a Token-2022 account for the real mint was recreated and the stock came back",
    );
    assert.equal(
      await amountAt(ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM)),
      BigInt(DEMO.guaranteePerMember),
      "and so did the guarantee",
    );
  });

  it("refuses a second withdraw and a second release inside ONE transaction", async () => {
    await setUp(5, DEMO, DEMO_LOCK);
    await fundTheRound();

    // Two release_pots in one transaction. The second must not see a round that
    // still looks funded.
    const releaseIx = await releaseBuilder(creator, wallets[0]!.publicKey).instruction();
    const doubleRelease = new anchor.web3.Transaction();
    doubleRelease.recentBlockhash = h.context.lastBlockhash;
    doubleRelease.feePayer = creator.publicKey;
    doubleRelease.add(releaseIx, releaseIx);
    doubleRelease.sign(creator);

    await assert.rejects(
      h.context.banksClient.processTransaction(doubleRelease),
      "a round must not pay twice in one transaction",
    );
    assert.equal((await readCircle()).round, 0, "the whole transaction reverted");

    for (let round = 0; round < 5; round += 1) {
      if (round > 0) await fundTheRound();
      await release(creator, wallets[round]!.publicKey);
    }

    // Two withdraws in one transaction, for the same member.
    const w = wallets[1]!;
    const withdrawIx = await withdrawBuilder(w).instruction();
    const doubleWithdraw = new anchor.web3.Transaction();
    doubleWithdraw.recentBlockhash = h.context.lastBlockhash;
    doubleWithdraw.feePayer = w.publicKey;
    doubleWithdraw.add(withdrawIx, withdrawIx);
    doubleWithdraw.sign(w);

    await assert.rejects(
      h.context.banksClient.processTransaction(doubleWithdraw),
      "a member must not be paid twice in one transaction",
    );
    assert.equal(
      (await readCircle()).withdrawnUsdc.toNumber(),
      0,
      "and nothing was paid at all",
    );
  });
});
