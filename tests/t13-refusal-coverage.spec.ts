/**
 * The two refusal codes that SPEC §10 G2 requires and the suite lacked.
 *
 * The gate 2 brief claimed both were structurally untestable. Codex's gate 2
 * review corrected that, and it was right: I had confused "unreachable in
 * production" with "untestable", which are different things. The harness writes
 * arbitrary account bytes at arbitrary addresses. That is how every fixture in
 * this repo works, and it is how both of these are reached.
 *
 *   AlreadyDefaulted   defaulted_bitmap cannot be set by any instruction until
 *                      declare_default arrives at T15. It can be set by writing
 *                      the Circle account, which is what a declared default
 *                      will eventually do.
 *
 *   MultiplierInvalid  ADR-012's allowlist stops an unvetted mint reaching the
 *                      program. It says nothing about what the bytes AT an
 *                      allowlisted address contain, and the issuer owns those.
 *                      A mint whose scaled multiplier is NaN is exactly the
 *                      asset SPEC §9 calls ineligible.
 *
 * Neither test needs a production transaction it cannot make. Both assert the
 * refusal the SPEC names, at the instruction the SPEC names it for.
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
  fixture,
  harness,
  initFeed,
  poolAddress,
  priceFeedAddress,
  quoteIx,
  send,
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

/** ScaledUiAmountConfig, SPEC §9b: TLV type 25, 56 bytes of payload,
 *  authority(32) then multiplier(f64) then effective ts(i64) then
 *  new_multiplier(f64). */
const SCALED_UI_AMOUNT_CONFIG = 25;

/**
 * The real mint's bytes with its multipliers replaced.
 *
 * Everything else stays: the address is the allowlisted one, the owner is
 * Token-2022, every other extension is the issuer's own. Only the eight bytes
 * the program reads as a multiplier change, which is the one field an issuer
 * could plausibly set to something the program must refuse.
 */
function mintWithMultiplierBits(symbol: "NFLXx", bits: bigint): Buffer {
  const data = Buffer.from(fixture(symbol).dataBase64, "base64");

  let offset = 166; // 165 base + 1 account-type discriminant
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const len = data.readUInt16LE(offset + 2);
    if (type === 0) break;

    if (type === SCALED_UI_AMOUNT_CONFIG) {
      const payload = offset + 4;
      data.writeBigUInt64LE(bits, payload + 32); // multiplier
      data.writeBigUInt64LE(bits, payload + 48); // new_multiplier
      return data;
    }
    offset += 4 + len;
  }

  throw new Error(`${symbol} carries no ScaledUiAmountConfig`);
}

describe("G2 refusal coverage: the two codes the suite lacked", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let creator: anchor.web3.Keypair;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;

  const memberAddress = (w: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), w.toBuffer()],
      h.program.programId,
    )[0];

  beforeEach(async () => {
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

    circle = circleAddress(h.program, creator.publicKey, 0n);

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
      const s = tokenAccount({
        mint: stockMint,
        owner: w.publicKey,
        amount: LOCK_RAW * 2n,
        tokenProgram: TOKEN_2022_PROGRAM,
      });
      h.putAccount(ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM), s.data, s.owner);

      const u = tokenAccount({
        mint: usdcMint,
        owner: w.publicKey,
        amount: BigInt(DEMO.guaranteePerMember + DEMO.contribution * N),
        tokenProgram: SPL_TOKEN_PROGRAM,
      });
      h.putAccount(ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM), u.data, u.owner);
    }
  });

  /**
   * SPEC §5, contribute: `already_defaulted`.
   *
   * A defaulted member's remaining contributions are prepaid from their stock
   * by the waterfall, so letting them pay again would take money for an
   * obligation the circle has already settled.
   */
  it("contribute refuses a member whose seat is marked defaulted", async () => {
    for (const w of wallets) {
      await call(h.program, "joinAndLock", [new BN(LOCK_RAW.toString())])
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
    }

    await call(h.program, "activate", [])
      .accounts({ creator: creator.publicKey, circle })
      .signers([creator])
      .rpc();

    // Mark seat 2 defaulted. declare_default is T15; this writes the state it
    // will eventually write, which is the only part contribute reads.
    const state = await fetchAccount<Record<string, unknown>>(h.program, "circle", circle);
    h.putAccount(
      circle,
      await h.program.coder.accounts.encode("circle", {
        ...state,
        defaultedBitmap: 0b00010,
      }),
      h.program.programId,
    );

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

    assert.equal(await h.refusal(contribute(wallets[1]!)), "AlreadyDefaulted");

    // And the refusal is about that seat, not about the circle: every other
    // member can still pay, which is what keeps a default from halting the
    // round for people who did nothing wrong.
    await contribute(wallets[0]!);
    await contribute(wallets[2]!);
  });

  /**
   * SPEC §5, the valuation path: `multiplier_invalid`.
   *
   * ADR-012's allowlist governs WHICH address may be used. It says nothing
   * about the bytes at that address, and the issuer owns those. SPEC §9 calls a
   * mint whose multiplier cannot be read safely an ineligible asset, and the
   * program must refuse rather than value it at zero: a zero multiplier does
   * not mean the stock is worthless, it means the mint is not saying what it is
   * worth.
   */
  it("the valuation path refuses a mint whose multiplier cannot be read safely", async () => {
    const cases: [string, bigint][] = [
      ["NaN", 0x7ff8_0000_0000_0000n],
      ["positive infinity", 0x7ff0_0000_0000_0000n],
      ["negative", 0xbff0_0000_0000_0000n],
      ["negative zero", 0x8000_0000_0000_0000n],
      ["zero", 0x0000_0000_0000_0000n],
    ];

    for (const [name, bits] of cases) {
      h.putAccount(
        stockMint,
        mintWithMultiplierBits("NFLXx", bits),
        new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
      );

      const ix = await quoteIx(h, stockMint, {
        raw: LOCK_RAW.toString(),
        haircutBps: DEMO.haircutBps,
        maxPriceAge: DEMO.maxPriceAge,
      });

      // send() defaults to a fresh fee payer per call, so five otherwise
      // identical transactions carry five different signatures and each one
      // actually reaches the program.
      assert.equal(
        await h.refusal(send(h, ix)),
        "MultiplierInvalid",
        `a multiplier of ${name} must be refused, not valued`,
      );
    }
  });
});
