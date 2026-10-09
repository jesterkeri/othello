/**
 * U1 adversary (slice 1, USDC collateral): the state unions and the feature marker at their edges
 * (othello-design/USDC-COLLATERAL-DESIGN.md r8, "State (Option B)" and [R3-1]; SPEC §4b).
 *
 * Accounts that no instruction can create are planted with bankrun setAccount, encoded with the program's own coder
 * or the SeatCollateral layout below. The last case plants a pre-state no slice-1 instruction can reach (a
 * SeatCollateral holding USDC with the collateral vault absent) to check the design's [R3-1] rule directly.
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
  fetchAccount,
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
/** SPEC.md:137's demo circle. 1.0 token counts for exactly min_stock_cover (H = 150 x 0.8 = 120). */
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

/**
 * SeatCollateral is never a typed account in any instruction (it is read as a state union), so Anchor leaves it out
 * of the IDL. Its layout, by hand: discriminator sha256("account:SeatCollateral")[..8], circle, wallet,
 * usdc_locked u64 LE, bump.
 */
const SEAT_DISCRIMINATOR = createHash("sha256").update("account:SeatCollateral").digest().subarray(0, 8);
type SeatState = { circle: anchor.web3.PublicKey; wallet: anchor.web3.PublicKey; usdcLocked: bigint; bump: number };
function decodeSeat(data: Buffer): SeatState {
  assert.ok(data.subarray(0, 8).equals(SEAT_DISCRIMINATOR), "not a SeatCollateral");
  return {
    circle: new anchor.web3.PublicKey(data.subarray(8, 40)),
    wallet: new anchor.web3.PublicKey(data.subarray(40, 72)),
    usdcLocked: data.readBigUInt64LE(72),
    bump: data[80]!,
  };
}
function encodeSeat(s: SeatState): Buffer {
  const b = Buffer.alloc(81);
  SEAT_DISCRIMINATOR.copy(b, 0);
  s.circle.toBuffer().copy(b, 8);
  s.wallet.toBuffer().copy(b, 40);
  b.writeBigUInt64LE(s.usdcLocked, 72);
  b[80] = s.bump;
  return b;
}
type MemberState = { stockRaw: { toString(): string }; guarantee: { toString(): string }; turn: number };
type CircleState = { joinedBitmap: number; reserveTotal: { toString(): string }; depositsTotal: { toString(): string }; status: Record<string, unknown> };

describe("U1 adversary: the state unions and the marker at the edges", () => {
  let h: Harness;
  const stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
  const usdcMint = APPROVED_USDC;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;
  let pool: anchor.web3.PublicKey;

  const pdaB = (seeds: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(seeds, h.program.programId);
  const pda = (seeds: Buffer[]) => pdaB(seeds)[0];
  const memberAddress = (w: anchor.web3.PublicKey) => pda([Buffer.from("member"), circle.toBuffer(), w.toBuffer()]);
  const seatAddress = (w: anchor.web3.PublicKey) => pda([Buffer.from("seat_usdc"), circle.toBuffer(), w.toBuffer()]);
  const vaultAddress = () => pda([Buffer.from("usdc_collateral"), circle.toBuffer()]);
  const featuresAddress = () => pda([Buffer.from("features")]);
  const enable = () =>
    call(h.program, "enableUsdcCollateral", [])
      .accounts({
        authority: h.authority.publicKey,
        program: h.program.programId,
        programData: programDataAddress(h.program.programId),
        features: featuresAddress(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([h.authority])
      .rpc();
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

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);
    const [p, bump] = poolAddress(h.program, usdcMint, stockMint);
    pool = p;
    h.putAccount(pool, await h.program.coder.accounts.encode("liquidationPool", { authority: h.authority.publicKey, bump, discountBps: 2000 }), h.program.programId);
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: PRICE, share: PRICE, stamp: CURRENT, expected: ONE_X });
    wallets = Array.from({ length: 3 }, () => h.fund());
    circle = circleAddress(h.program, wallets[0]!.publicKey, 0n);
    await call(h.program, "createCircle", [
      {
        circleId: new BN(0), contribution: new BN(DEMO.contribution), roundSecs: new BN(DEMO.roundSecs), graceSecs: new BN(DEMO.graceSecs),
        haircutBps: DEMO.haircutBps, coverageBps: DEMO.coverageBps, warnBps: DEMO.warnBps, guaranteePerMember: new BN(DEMO.guaranteePerMember),
        minStockCover: new BN(DEMO.minStockCover), maxPriceAge: new BN(DEMO.maxPriceAge),
      },
      wallets.map((w) => w.publicKey),
    ])
      .accounts({ creator: wallets[0]!.publicKey, circle, stockMint, usdcMint, priceFeed: priceFeedAddress(h.program, stockMint), pool, systemProgram: anchor.web3.SystemProgram.programId })
      .signers([wallets[0]!])
      .rpc();
    for (const w of wallets) {
      const s = tokenAccount({ mint: stockMint, owner: w.publicKey, amount: 200_000_000n, tokenProgram: TOKEN_2022_PROGRAM });
      h.putAccount(ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM), s.data, s.owner);
      const u = tokenAccount({ mint: usdcMint, owner: w.publicKey, amount: G + 500n * USDC, tokenProgram: SPL_TOKEN_PROGRAM });
      h.putAccount(ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM), u.data, u.owner);
    }
  });

  it("a SeatCollateral at the seat's address whose stored bump does not derive it is refused", async () => {
    await enable();
    const w = wallets[1]!;
    const [addr, bump] = pdaB([Buffer.from("seat_usdc"), circle.toBuffer(), w.publicKey.toBuffer()]);
    h.putAccount(addr, encodeSeat({ circle, wallet: w.publicKey, usdcLocked: 0n, bump: bump - 1 }), h.program.programId);
    assert.equal(await h.refusal(joinV2(w, 0n, MIN)), "BadSeatCollateral");
    h.putAccount(addr, encodeSeat({ circle, wallet: w.publicKey, usdcLocked: 0n, bump }), h.program.programId);
    await h.nextSlot();
    await joinV2(w, 0n, MIN);
    assert.equal(decodeSeat(Buffer.from((await h.context.banksClient.getAccount(addr))!.data)).usdcLocked, MIN);
  });

  it("a vault at the PDA: wrong mint, wrong authority, Token-2022 owner, all refused", async () => {
    await enable();
    const w = wallets[1]!;
    const other = anchor.web3.Keypair.generate().publicKey;
    const cases: [anchor.web3.PublicKey, anchor.web3.PublicKey, string][] = [
      [other, circle, SPL_TOKEN_PROGRAM],
      [usdcMint, other, SPL_TOKEN_PROGRAM],
      [usdcMint, circle, TOKEN_2022_PROGRAM],
    ];
    for (const [mint, owner, prog] of cases) {
      const t = tokenAccount({ mint, owner, amount: 0n, tokenProgram: prog });
      h.putAccount(vaultAddress(), t.data, t.owner);
      assert.equal(await h.refusal(joinV2(w, 0n, MIN)), "BadCollateralVault", `${mint} ${owner} ${prog}`);
      await h.nextSlot();
    }
  });

  it("a marker at the PDA with a stored bump that does not derive it is refused", async () => {
    await enable();
    const [addr, bump] = pdaB([Buffer.from("features")]);
    const info = (await h.context.banksClient.getAccount(addr))!;
    const data = Buffer.from(info.data);
    assert.equal(data[8], bump);
    data[8] = bump - 1;
    h.putAccount(addr, data, h.program.programId);
    assert.equal(await h.refusal(joinV2(wallets[1]!, 0n, MIN)), "UsdcCollateralNotEnabled");
  });

  it("add_usdc_collateral works when Active", async () => {
    await enable();
    for (const w of wallets) await joinV2(w, 0n, MIN);
    await call(h.program, "activate", []).accounts({ creator: wallets[0]!.publicKey, circle }).signers([wallets[0]!]).rpc();
    await addUsdc(wallets[2]!, 3n);
    const s = decodeSeat(Buffer.from((await h.context.banksClient.getAccount(seatAddress(wallets[2]!.publicKey)))!.data));
    assert.equal(s.usdcLocked, MIN + 3n);
    assert.equal(tokenAmount(Buffer.from((await h.context.banksClient.getAccount(vaultAddress()))!.data)), 3n * MIN + 3n);
  });

  it("a USDC lock on a circle stored with another USDC mint is refused", async () => {
    await enable();
    const other = anchor.web3.Keypair.generate().publicKey;
    const m = splMintAccount(6);
    h.putAccount(other, m.data, m.owner);
    const info = (await h.context.banksClient.getAccount(circle))!;
    const c = await h.program.coder.accounts.decode("circle", Buffer.from(info.data));
    c.usdcMint = other;
    h.putAccount(circle, await h.program.coder.accounts.encode("circle", c), h.program.programId);
    const w = wallets[1]!;
    const u = tokenAccount({ mint: other, owner: w.publicKey, amount: G + 500n * USDC, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(ataAddress(other, w.publicKey, SPL_TOKEN_PROGRAM), u.data, u.owner);
    const r = await h.refusal(
      call(h.program, "joinAndLockV2", [new BN(0), new BN(MIN.toString())])
        .accounts({
          wallet: w.publicKey, circle, member: memberAddress(w.publicKey), stockMint, usdcMint: other,
          priceFeed: priceFeedAddress(h.program, stockMint),
          memberStockAta: ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM),
          memberUsdcAta: ataAddress(other, w.publicKey, SPL_TOKEN_PROGRAM),
          circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
          circleUsdcVault: ataAddress(other, circle, SPL_TOKEN_PROGRAM),
          seatCollateral: seatAddress(w.publicKey), collateralVault: vaultAddress(), features: featuresAddress(),
          stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM), usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
          associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM), systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([w])
        .rpc(),
    );
    assert.equal(r, "UsdcMintNotApproved");
  });
  it("design [R3-1]: a present SeatCollateral with usdc_locked > 0 and an absent vault is BadCollateralVault (pre-state planted)", async () => {
    await enable();
    const w = wallets[1]!;
    await joinV2(w, 110_000_000n, 0n);
    const [addr, bump] = pdaB([Buffer.from("seat_usdc"), circle.toBuffer(), w.publicKey.toBuffer()]);
    h.putAccount(addr, encodeSeat({ circle, wallet: w.publicKey, usdcLocked: 5n, bump }), h.program.programId);
    assert.equal(await h.context.banksClient.getAccount(vaultAddress()), null);
    assert.equal(await h.refusal(addUsdc(w, 1n)), "BadCollateralVault");
  });
});
