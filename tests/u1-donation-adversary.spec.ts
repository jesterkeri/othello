/**
 * U1 adversary on 963a63b (USDC slice 1): I4b as a lower bound (SPEC §4b I4b; INVARIANTS.md I4b; othello-design/
 * USDC-COLLATERAL-DESIGN.md r9 [C32-1]). "A donation is no seat's collateral and no member's cover, no instruction
 * counts it or refuses because of it."
 *
 * The donation here is a real SPL Token TransferChecked signed by a stranger who is no member, sent through bankrun
 * to the collateral vault, not a planted balance. It covers the shapes u1-usdc-collateral-join.spec.ts does not: a
 * stock-only v2 join, a stock seat's first add_usdc_collateral into a donated vault, the stock+USDC cover boundary
 * one base unit either side, and a donation larger than every seat's lock together.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import * as anchor from "@coral-xyz/anchor";

import {
  APPROVED_USDC,
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
  harness,
  initFeed,
  poolAddress,
  priceFeedAddress,
  programDataAddress,
  setPrices,
  splMintAccount,
  tokenAccount,
  tokenAmount,
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000n;
const DEMO = {
  contribution: 50 * 1_000_000,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13_000,
  warnBps: 11_000,
  guaranteePerMember: 35 * 1_000_000,
  minStockCover: 120 * 1_000_000,
  maxPriceAge: 691_200,
};
const PRICE = 150 * 1_000_000;
const MIN = BigInt(DEMO.minStockCover);
const G = BigInt(DEMO.guaranteePerMember);
/** Half a token: H = 75 x 0.8 = 60 USDC exactly. */
const HALF_TOKEN = 50_000_000n;
const SEAT_DISCRIMINATOR = createHash("sha256").update("account:SeatCollateral").digest().subarray(0, 8);

describe("U1 adversary: a donation to the collateral vault is nobody's cover and refuses nothing (I4b r9)", () => {
  let h: Harness;
  const stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
  const usdcMint = APPROVED_USDC;
  let wallets: anchor.web3.Keypair[];
  let stranger: anchor.web3.Keypair;
  let circle: anchor.web3.PublicKey;

  const pda = (seeds: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(seeds, h.program.programId)[0];
  const memberAddress = (w: anchor.web3.PublicKey) => pda([Buffer.from("member"), circle.toBuffer(), w.toBuffer()]);
  const seatAddress = (w: anchor.web3.PublicKey) => pda([Buffer.from("seat_usdc"), circle.toBuffer(), w.toBuffer()]);
  const vaultAddress = () => pda([Buffer.from("usdc_collateral"), circle.toBuffer()]);
  const featuresAddress = () => pda([Buffer.from("features")]);

  const joinV2 = (w: anchor.web3.Keypair, stock: bigint, usdc: bigint) =>
    call(h.program, "joinAndLockV2", [new BN(stock.toString()), new BN(usdc.toString())])
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
        seatCollateral: seatAddress(w.publicKey),
        collateralVault: vaultAddress(),
        features: featuresAddress(),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([w])
      .rpc();

  const addUsdc = (w: anchor.web3.Keypair, amount: bigint) =>
    call(h.program, "addUsdcCollateral", [new BN(amount.toString())])
      .accounts({
        wallet: w.publicKey,
        circle,
        member: memberAddress(w.publicKey),
        seatCollateral: seatAddress(w.publicKey),
        collateralVault: vaultAddress(),
        features: featuresAddress(),
        usdcMint,
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([w])
      .rpc();

  const raw = async (k: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(k);
    return info ? { data: Buffer.from(info.data), owner: info.owner } : null;
  };
  const amountAt = async (k: anchor.web3.PublicKey) => {
    const a = await raw(k);
    return a && a.data.length >= 72 ? tokenAmount(a.data) : null;
  };
  const lockedOf = async (w: anchor.web3.PublicKey) => {
    const a = await raw(seatAddress(w));
    if (!a) return 0n;
    assert.ok(a.data.subarray(0, 8).equals(SEAT_DISCRIMINATOR), "not a SeatCollateral");
    return a.data.readBigUInt64LE(72);
  };
  const assertI4b = async (donated: bigint) => {
    let sum = 0n;
    for (const w of wallets) sum += await lockedOf(w.publicKey);
    assert.equal((await amountAt(vaultAddress())) ?? 0n, sum + donated, "I4b: the collateral vault is not Σ usdc_locked + donations");
  };

  /**
   * A stranger's own SPL Token TransferChecked (instruction 12: amount u64 LE, decimals u8) from their USDC account
   * straight into the collateral vault. Othello is not in the transaction.
   */
  const donate = async (amount: bigint) => {
    await h.nextSlot();
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(amount, 1);
    data[9] = 6;
    const ix = new anchor.web3.TransactionInstruction({
      programId: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      keys: [
        { pubkey: ataAddress(usdcMint, stranger.publicKey, SPL_TOKEN_PROGRAM), isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: vaultAddress(), isSigner: false, isWritable: true },
        { pubkey: stranger.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
    const tx = new anchor.web3.Transaction();
    tx.recentBlockhash = (await h.context.banksClient.getLatestBlockhash())![0];
    tx.feePayer = stranger.publicKey;
    tx.add(ix);
    tx.sign(stranger);
    const r = await h.context.banksClient.tryProcessTransaction(tx);
    assert.equal(r.result, null, `the donation itself must go through: ${String(r.result)}`);
  };

  function fund(w: anchor.web3.PublicKey, stock: bigint, usdc: bigint) {
    const s = tokenAccount({ mint: stockMint, owner: w, amount: stock, tokenProgram: TOKEN_2022_PROGRAM });
    h.putAccount(ataAddress(stockMint, w, TOKEN_2022_PROGRAM), s.data, s.owner);
    const u = tokenAccount({ mint: usdcMint, owner: w, amount: usdc, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(ataAddress(usdcMint, w, SPL_TOKEN_PROGRAM), u.data, u.owner);
  }

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);
    const [pool, bump] = poolAddress(h.program, usdcMint, stockMint);
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", { authority: h.authority.publicKey, bump, discountBps: 2000 }),
      h.program.programId,
    );
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: PRICE, share: PRICE, stamp: CURRENT, expected: ONE_X });

    wallets = Array.from({ length: 5 }, () => h.fund());
    stranger = h.fund();
    circle = circleAddress(h.program, wallets[0]!.publicKey, 0n);
    await call(h.program, "createCircle", [
      {
        circleId: new BN(0),
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
        creator: wallets[0]!.publicKey,
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallets[0]!])
      .rpc();
    for (const w of wallets) fund(w.publicKey, 200_000_000n, G + 500n * USDC);
    fund(stranger.publicKey, 0n, 10_000n * USDC);
    await call(h.program, "enableUsdcCollateral", [])
      .accounts({
        authority: h.authority.publicKey,
        program: h.program.programId,
        programData: programDataAddress(h.program.programId),
        features: featuresAddress(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([h.authority])
      .rpc();
  });

  it("a donation larger than every lock together: the stock+USDC boundary is unmoved, a stock-only v2 join and a stock seat's first add go through", async () => {
    await joinV2(wallets[1]!, 0n, MIN);
    const DONATION = 5_000n * USDC + 1n;
    await donate(DONATION);
    await assertI4b(DONATION);

    // the stock+USDC boundary: half a token (60) + 60 USDC exactly; one base unit less is refused even though the
    // vault holds 5,000 USDC nobody locked
    assert.equal(await h.refusal(joinV2(wallets[2]!, HALF_TOKEN, 60n * USDC - 1n)), "CollateralBelowMinimum");
    await h.nextSlot();
    await joinV2(wallets[2]!, HALF_TOKEN, 60n * USDC);

    // a stock-only v2 join reads the donated vault and is not refused because of it; its seat holds no USDC
    await joinV2(wallets[3]!, 110_000_000n, 0n);
    assert.equal(await raw(seatAddress(wallets[3]!.publicKey)), null, "a stock-only join creates no SeatCollateral");

    // a stock seat's first add into the donated vault credits exactly what it sent
    await addUsdc(wallets[3]!, 1n);
    assert.equal(await lockedOf(wallets[3]!.publicKey), 1n);

    // a stock-only seat cannot borrow the donation as cover: 1 base unit under min_stock_cover in stock alone
    // (H(stock) for 99,999,999 raw = floor(149.99999850 x 0.8) < 120) is refused
    assert.equal(await h.refusal(joinV2(wallets[4]!, 99_999_999n, 0n)), "CollateralBelowMinimum");

    assert.equal(await lockedOf(wallets[1]!.publicKey), MIN);
    assert.equal(await lockedOf(wallets[2]!.publicKey), 60n * USDC);
    await assertI4b(DONATION);
  });

  it("two donations either side of a lock add up, and each lock still credits only its own amount", async () => {
    await joinV2(wallets[1]!, 0n, MIN);
    await donate(1n);
    await addUsdc(wallets[1]!, 2n);
    await donate(3n * USDC);
    await joinV2(wallets[2]!, 0n, MIN);
    assert.equal(await lockedOf(wallets[1]!.publicKey), MIN + 2n);
    assert.equal(await lockedOf(wallets[2]!.publicKey), MIN);
    await assertI4b(1n + 3n * USDC);
  });
});
