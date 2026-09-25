/**
 * T12: withdraw, and I3, I11, I16.
 *
 * I16 is "withdraw order does not change any member's amount", and INVARIANTS
 * asks for a property test over permutations. So the same circle is run to
 * Completed three times and withdrawn in three different orders, and every
 * member's payout is compared across all three. A single order would prove
 * nothing: the bug this invariant exists to catch only shows when someone goes
 * last.
 *
 * The pro-rata arithmetic itself is degenerate in gate 2, because unequal
 * weights need a default (T15) or a top-up (T16) and neither exists yet. It is
 * exercised with asymmetric inputs in withdraw.rs's own unit tests instead of
 * being left untested until then.
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

type CircleState = {
  status: Record<string, unknown>;
  withdrawnBitmap: number;
  withdrawnUsdc: { toNumber(): number };
  reserveTotal: { toNumber(): number };
  reserveLosses: { toNumber(): number };
  escrow: { toNumber(): number };
  heldContributions: { toNumber(): number };
  depositsTotal: { toNumber(): number };
};

type MemberState = { turn: number; stockRaw: { toString(): string } };

describe("T12 withdraw, I3, I11 and I16", () => {
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

  const balance = async (owner: anchor.web3.PublicKey, mint: anchor.web3.PublicKey, prog: string) => {
    const info = await h.context.banksClient.getAccount(ataAddress(mint, owner, prog));
    return info ? tokenAmount(Buffer.from(info.data)) : 0n;
  };

  /** INVARIANTS.md I3, with the dust allowance it carries. */
  async function assertI3(after: string) {
    const c = await readCircle();
    const expected =
      c.reserveTotal.toNumber() -
      c.reserveLosses.toNumber() +
      c.escrow.toNumber() +
      c.heldContributions.toNumber() -
      c.withdrawnUsdc.toNumber();
    const actual = Number(await balance(circle, usdcMint, SPL_TOKEN_PROGRAM));

    assert.ok(
      actual >= expected,
      `I3 after ${after}: vault ${actual} below the accounted ${expected}`,
    );
    assert.ok(
      actual - expected <= N,
      `I3 after ${after}: vault ${actual} exceeds ${expected} by more than dust`,
    );
  }

  function fundWallet(wallet: anchor.web3.PublicKey) {
    const s = tokenAccount({
      mint: stockMint,
      owner: wallet,
      amount: LOCK_RAW * 2n,
      tokenProgram: TOKEN_2022_PROGRAM,
    });
    h.putAccount(ataAddress(stockMint, wallet, TOKEN_2022_PROGRAM), s.data, s.owner);
    const u = tokenAccount({
      mint: usdcMint,
      owner: wallet,
      amount: BigInt(DEMO.guaranteePerMember + DEMO.contribution * N * 2),
      tokenProgram: SPL_TOKEN_PROGRAM,
    });
    h.putAccount(ataAddress(usdcMint, wallet, SPL_TOKEN_PROGRAM), u.data, u.owner);
  }

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
      .remainingAccounts(
        wallets.map((w) => ({
          pubkey: memberAddress(w.publicKey),
          isWritable: true,
          isSigner: false,
        })),
      )
      .signers([creator])
      .rpc();

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

    for (const w of wallets) fundWallet(w.publicKey);
    for (const w of wallets) await join(w);
  }

  const activate = () =>
    call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

  async function runToCompleted() {
    await setUp();
    await activate();
    for (let round = 0; round < N; round += 1) {
      for (const w of wallets) await contribute(w);
      await release(wallets[round]!.publicKey);
    }
  }

  it("refuses while the circle is still running, and refuses twice after", async () => {
    await setUp();
    await activate();
    assert.equal(await h.refusal(withdraw(wallets[0]!)), "NotFinished");

    for (let round = 0; round < N; round += 1) {
      for (const w of wallets) await contribute(w);
      await release(wallets[round]!.publicKey);
    }

    await withdraw(wallets[0]!);
    await h.nextSlot();
    assert.equal(await h.refusal(withdraw(wallets[0]!)), "AlreadyWithdrawn");
  });

  it("a cancelled circle returns exactly what each member put in", async () => {
    await setUp();
    await call(h.program, "cancelCircle", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    for (const w of wallets) {
      const usdcBefore = await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM);
      const stockBefore = await balance(w.publicKey, stockMint, TOKEN_2022_PROGRAM);

      await withdraw(w);

      assert.equal(
        (await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM)) - usdcBefore,
        BigInt(DEMO.guaranteePerMember),
        "the whole guarantee, with nothing kept back",
      );
      assert.equal(
        (await balance(w.publicKey, stockMint, TOKEN_2022_PROGRAM)) - stockBefore,
        LOCK_RAW,
        "and every locked token",
      );
      assert.equal(
        (await readMember(w.publicKey)).stockRaw.toString(),
        "0",
        "stock_raw is zeroed so I4 stays true",
      );
      await assertI3("a cancelled withdraw");
    }

    assert.equal(
      await balance(circle, stockMint, TOKEN_2022_PROGRAM),
      0n,
      "the stock vault is empty",
    );
    assert.equal(
      await balance(circle, usdcMint, SPL_TOKEN_PROGRAM),
      0n,
      "and so is the usdc vault",
    );
  });

  it("I3 and I11: a completed circle pays every deposit back and never more", async () => {
    await runToCompleted();

    let paidOut = 0n;
    for (const w of wallets) {
      const before = await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM);
      await withdraw(w);
      paidOut += (await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM)) - before;
      await assertI3("a completed withdraw");
    }

    const c = await readCircle();

    // I11: total withdrawals never exceed total deposits less what was lost.
    assert.ok(
      paidOut <= BigInt(c.depositsTotal.toNumber() - c.reserveLosses.toNumber()),
      `I11: paid out ${paidOut} against deposits ${c.depositsTotal.toNumber()}`,
    );
    // No default happened, so it is exactly the deposits.
    assert.equal(paidOut, BigInt(DEMO.guaranteePerMember * N));
    assert.equal(c.withdrawnBitmap, 0b11111);

    for (const w of wallets) {
      assert.equal(
        await balance(w.publicKey, stockMint, TOKEN_2022_PROGRAM),
        LOCK_RAW * 2n,
        "every member has all their stock back",
      );
    }
    assert.equal(await balance(circle, stockMint, TOKEN_2022_PROGRAM), 0n);
  });

  /**
   * I16. Three orders, three fresh circles, every member's payout compared.
   *
   * withdraw reads reserve_total, reserve_losses and escrow as snapshots and
   * decrements none of them, so this holds by construction. The implementation
   * it rules out is the obvious one: paying out of a pool that shrinks as
   * people withdraw, which makes the last member's share depend on an order
   * they do not control.
   */
  it("I16: withdraw order does not change any member's amount", async () => {
    const orders = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
    ];
    const results: Record<number, bigint>[] = [];

    for (const order of orders) {
      await runToCompleted();

      const paid: Record<number, bigint> = {};
      for (const seat of order) {
        const w = wallets[seat]!;
        const before = await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM);
        await withdraw(w);
        paid[seat] = (await balance(w.publicKey, usdcMint, SPL_TOKEN_PROGRAM)) - before;
      }
      results.push(paid);
    }

    for (let seat = 0; seat < N; seat += 1) {
      const amounts = results.map((r) => r[seat]!);
      assert.equal(
        new Set(amounts.map(String)).size,
        1,
        `seat ${seat + 1} was paid differently depending on order: ${amounts.join(", ")}`,
      );
    }
  });
});
