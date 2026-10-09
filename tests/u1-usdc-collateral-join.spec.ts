/**
 * USDC collateral, slice 1 (SPEC §4b; othello-design/USDC-COLLATERAL-DESIGN.md r9): the pinned USDC mint, the
 * feature marker, join_and_lock_v2 and add_usdc_collateral, on the default build in bankrun with the real NFLXx
 * mint bytes.
 *
 * What is proved:
 * - [F1] create_circle takes only APPROVED_USDC under SPL Token.
 * - The marker is admin-only and one-way; without it no USDC can be locked.
 * - H(seat) = stock part + USDC at face value, at the exact min_stock_cover boundary; a USDC-only join reads no
 *   price (it succeeds with the feed stale and repricing).
 * - The SeatCollateral and the collateral vault are state unions: absent works (also when someone sent SOL to the
 *   address), a substituted vault or another seat's account is refused, and nothing moves on a refusal.
 * - join_and_lock is unchanged: with usdc 0, v2 creates nothing USDC-side; the legacy join still reads the price.
 * - I4b: the collateral vault holds at least the sum of usdc_locked, after every lock: exactly the sum where nobody
 *   donates, and the sum plus the donation where someone sends USDC straight to the vault. A donation is nobody's
 *   cover, and no instruction refuses because of it (design r9 [C32-1]).
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

describe("U1 USDC collateral: pinned mint, marker, join_and_lock_v2, add_usdc_collateral", () => {
  let h: Harness;
  const stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
  const usdcMint = APPROVED_USDC;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;
  let circleId = 0n;

  const pda = (seeds: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(seeds, h.program.programId)[0];
  const memberAddress = (w: anchor.web3.PublicKey, c = circle) => pda([Buffer.from("member"), c.toBuffer(), w.toBuffer()]);
  const seatAddress = (w: anchor.web3.PublicKey, c = circle) => pda([Buffer.from("seat_usdc"), c.toBuffer(), w.toBuffer()]);
  const vaultAddress = (c = circle) => pda([Buffer.from("usdc_collateral"), c.toBuffer()]);
  const featuresAddress = () => pda([Buffer.from("features")]);

  const enable = (signer = h.authority) =>
    call(h.program, "enableUsdcCollateral", [])
      .accounts({
        authority: signer.publicKey,
        program: h.program.programId,
        programData: programDataAddress(h.program.programId),
        features: featuresAddress(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([signer])
      .rpc();

  type V2Overrides = Partial<{ seatCollateral: anchor.web3.PublicKey; collateralVault: anchor.web3.PublicKey; features: anchor.web3.PublicKey }>;
  const joinV2 = (w: anchor.web3.Keypair, stock: bigint, usdc: bigint, o: V2Overrides = {}) =>
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
        seatCollateral: o.seatCollateral ?? seatAddress(w.publicKey),
        collateralVault: o.collateralVault ?? vaultAddress(),
        features: o.features ?? featuresAddress(),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([w])
      .rpc();

  const joinLegacy = (w: anchor.web3.Keypair, stock: bigint) =>
    call(h.program, "joinAndLock", [new BN(stock.toString())])
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

  const addUsdc = (w: anchor.web3.Keypair, amount: bigint, o: V2Overrides = {}) =>
    call(h.program, "addUsdcCollateral", [new BN(amount.toString())])
      .accounts({
        wallet: w.publicKey,
        circle,
        member: memberAddress(w.publicKey),
        seatCollateral: o.seatCollateral ?? seatAddress(w.publicKey),
        collateralVault: o.collateralVault ?? vaultAddress(),
        features: o.features ?? featuresAddress(),
        usdcMint,
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([w])
      .rpc();

  const raw = async (k: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(k);
    return info ? { data: Buffer.from(info.data), owner: info.owner, lamports: info.lamports } : null;
  };
  const amountAt = async (k: anchor.web3.PublicKey) => {
    const a = await raw(k);
    return a && a.data.length >= 72 ? tokenAmount(a.data) : null;
  };
  const usdcOf = (w: anchor.web3.PublicKey) => amountAt(ataAddress(usdcMint, w, SPL_TOKEN_PROGRAM));
  const seat = async (w: anchor.web3.PublicKey) => decodeSeat((await raw(seatAddress(w)))!.data);
  const lockedOf = async (w: anchor.web3.PublicKey) => ((await raw(seatAddress(w))) ? (await seat(w)).usdcLocked : 0n);

  /** I4b: collateral vault balance >= Σ usdc_locked; here exactly the sum plus what was donated straight to it. */
  const assertI4b = async (donated = 0n) => {
    let sum = 0n;
    for (const w of wallets) sum += await lockedOf(w.publicKey);
    assert.equal((await amountAt(vaultAddress())) ?? 0n, sum + donated, "I4b: the collateral vault is not Σ usdc_locked + donations");
  };
  /** Anyone can transfer USDC straight into the collateral vault, without Othello: the vault's balance grows. */
  const donate = async (amount: bigint) => {
    const v = tokenAccount({ mint: usdcMint, owner: circle, amount: (await amountAt(vaultAddress()))! + amount, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(vaultAddress(), v.data, v.owner);
  };

  function fund(w: anchor.web3.PublicKey, stock: bigint, usdc: bigint) {
    const s = tokenAccount({ mint: stockMint, owner: w, amount: stock, tokenProgram: TOKEN_2022_PROGRAM });
    h.putAccount(ataAddress(stockMint, w, TOKEN_2022_PROGRAM), s.data, s.owner);
    const u = tokenAccount({ mint: usdcMint, owner: w, amount: usdc, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(ataAddress(usdcMint, w, SPL_TOKEN_PROGRAM), u.data, u.owner);
  }

  const createCircle = (creator: anchor.web3.Keypair, members: anchor.web3.PublicKey[], mint = usdcMint) => {
    const id = circleId++;
    const address = circleAddress(h.program, creator.publicKey, id);
    return {
      address,
      send: () =>
        call(h.program, "createCircle", [
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
          members,
        ])
          .accounts({
            creator: creator.publicKey,
            circle: address,
            stockMint,
            usdcMint: mint,
            priceFeed: priceFeedAddress(h.program, stockMint),
            pool: poolAddress(h.program, mint, stockMint)[0],
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([creator])
          .rpc(),
    };
  };

  const putPool = async (mint: anchor.web3.PublicKey) => {
    const [pool, bump] = poolAddress(h.program, mint, stockMint);
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", { authority: h.authority.publicKey, bump, discountBps: 2000 }),
      h.program.programId,
    );
  };

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);
    await putPool(usdcMint);
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: PRICE, share: PRICE, stamp: CURRENT, expected: ONE_X });

    wallets = Array.from({ length: 5 }, () => h.fund());
    const c = createCircle(wallets[0]!, wallets.map((w) => w.publicKey));
    await c.send();
    circle = c.address;
    for (const w of wallets) fund(w.publicKey, 200_000_000n, G + 500n * USDC);
  });

  describe("[F1] the pinned USDC mint", () => {
    it("create_circle refuses another SPL mint, with its own pool in place so the mint check is what refuses", async () => {
      const other = anchor.web3.Keypair.generate().publicKey;
      const m = splMintAccount(6);
      h.putAccount(other, m.data, m.owner);
      await putPool(other);
      const c = createCircle(wallets[1]!, wallets.map((w) => w.publicKey), other);
      assert.equal(await h.refusal(c.send()), "UsdcMintNotApproved");
    });

    it("create_circle refuses a Token-2022 mint at the approved address", async () => {
      const m = splMintAccount(6);
      h.putAccount(usdcMint, m.data, new anchor.web3.PublicKey(TOKEN_2022_PROGRAM));
      const c = createCircle(wallets[1]!, wallets.map((w) => w.publicKey));
      assert.equal(await h.refusal(c.send()), "UsdcMintNotApproved");
    });
  });

  describe("the feature marker", () => {
    it("only the upgrade authority can create it; once only", async () => {
      const stranger = h.fund();
      assert.equal(await h.refusal(enable(stranger)), "Unauthorized");
      assert.equal(await raw(featuresAddress()), null);
      await enable();
      assert.ok(await raw(featuresAddress()));
      await h.nextSlot();
      await assert.rejects(enable(), "a second enable must fail (the marker already exists)");
    });

    it("without it, no USDC can be locked: join_and_lock_v2 with USDC and add_usdc_collateral refuse, nothing moves", async () => {
      const w = wallets[1]!;
      const before = await usdcOf(w.publicKey);
      assert.equal(await h.refusal(joinV2(w, 0n, MIN)), "UsdcCollateralNotEnabled");
      assert.equal(await usdcOf(w.publicKey), before);
      assert.equal(await raw(memberAddress(w.publicKey)), null);
      // a stock-only v2 join needs no marker
      await joinV2(w, 100_000_000n, 0n);
      assert.equal(await h.refusal(addUsdc(w, 10n * USDC)), "UsdcCollateralNotEnabled");
      assert.equal(await raw(seatAddress(w.publicKey)), null);
      assert.equal(await raw(vaultAddress()), null);
    });

    it("a marker-shaped account at another address is not the marker", async () => {
      await enable();
      const w = wallets[1]!;
      const fake = anchor.web3.Keypair.generate().publicKey;
      const real = (await raw(featuresAddress()))!;
      h.putAccount(fake, real.data, real.owner);
      assert.equal(await h.refusal(joinV2(w, 0n, MIN, { features: fake })), "UsdcCollateralNotEnabled");
    });
  });

  describe("join_and_lock_v2", () => {
    beforeEach(async () => {
      await enable();
    });

    it("USDC only, exactly the minimum: joins, the USDC goes to the collateral vault and the guarantee to the circle vault (I4b)", async () => {
      const w = wallets[1]!;
      const before = (await usdcOf(w.publicKey))!;
      await joinV2(w, 0n, MIN);

      const m = await fetchAccount<MemberState>(h.program, "member", memberAddress(w.publicKey));
      assert.equal(m.stockRaw.toString(), "0");
      assert.equal(m.turn, 1);
      const s = await seat(w.publicKey);
      assert.equal(s.usdcLocked.toString(), MIN.toString());
      assert.ok(s.circle.equals(circle) && s.wallet.equals(w.publicKey));
      assert.equal(await amountAt(vaultAddress()), MIN);
      assert.equal(await amountAt(ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM)), G, "only the guarantee in the circle USDC vault (I3 unchanged)");
      assert.equal(await usdcOf(w.publicKey), before - MIN - G);
      const c = await fetchAccount<CircleState>(h.program, "circle", circle);
      assert.equal(c.joinedBitmap, 0b10);
      assert.equal(c.reserveTotal.toString(), G.toString(), "locked USDC is not reserve");
      assert.equal(c.depositsTotal.toString(), G.toString(), "locked USDC is not a deposit");
      // the vault is the circle's, under SPL Token, of the approved mint
      const v = (await raw(vaultAddress()))!;
      assert.ok(v.owner.equals(new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM)));
      assert.ok(new anchor.web3.PublicKey(v.data.subarray(0, 32)).equals(usdcMint));
      assert.ok(new anchor.web3.PublicKey(v.data.subarray(32, 64)).equals(circle));
      await assertI4b();
    });

    it("USDC only, one base unit under the minimum: refused, nothing moves", async () => {
      const w = wallets[1]!;
      const before = await usdcOf(w.publicKey);
      assert.equal(await h.refusal(joinV2(w, 0n, MIN - 1n)), "CollateralBelowMinimum");
      assert.equal(await usdcOf(w.publicKey), before);
      assert.equal(await raw(seatAddress(w.publicKey)), null);
      assert.equal(await raw(vaultAddress()), null);
    });

    it("both: half a token (60 of cover) plus 60 USDC is exactly the minimum; 1 base unit less USDC is refused", async () => {
      const w = wallets[1]!;
      assert.equal(await h.refusal(joinV2(w, HALF_TOKEN, 60n * USDC - 1n)), "CollateralBelowMinimum");
      await h.nextSlot();
      await joinV2(w, HALF_TOKEN, 60n * USDC);
      const m = await fetchAccount<MemberState>(h.program, "member", memberAddress(w.publicKey));
      assert.equal(m.stockRaw.toString(), HALF_TOKEN.toString());
      assert.equal((await seat(w.publicKey)).usdcLocked.toString(), (60n * USDC).toString());
      await assertI4b();
    });

    it("a USDC-only join reads no price: it joins with the feed stale and past the split; a stock join is refused then", async () => {
      await h.setClock(BEFORE_SPLIT + DEMO.maxPriceAge + 10);
      const stockSeat = wallets[2]!;
      assert.notEqual(await h.refusal(joinV2(stockSeat, 100_000_000n, 0n)), "", "a stock join must read the price and refuse");
      await joinV2(wallets[1]!, 0n, MIN);
      assert.equal((await seat(wallets[1]!.publicKey)).usdcLocked.toString(), MIN.toString());
    });

    it("nothing at all is refused (InvalidParams)", async () => {
      assert.equal(await h.refusal(joinV2(wallets[1]!, 0n, 0n)), "InvalidParams");
    });

    it("with usdc 0 it is join_and_lock: no SeatCollateral, no collateral vault, no marker needed", async () => {
      await joinV2(wallets[1]!, 100_000_000n, 0n);
      assert.equal(await raw(seatAddress(wallets[1]!.publicKey)), null);
      assert.equal(await raw(vaultAddress()), null);
      await assertI4b();
    });

    it("the legacy join_and_lock is unchanged: stock only, and it still reads the price even for 0 stock", async () => {
      await joinLegacy(wallets[1]!, 110_000_000n);
      assert.equal(await raw(seatAddress(wallets[1]!.publicKey)), null);
      await h.setClock(BEFORE_SPLIT + DEMO.maxPriceAge + 10);
      const r = await h.refusal(joinLegacy(wallets[2]!, 0n));
      assert.ok(r === "PriceStale" || r === "MultiplierPriceMismatch", `legacy join with 0 stock must still read the price: ${r}`);
    });

    it("refuses the circle USDC vault (right mint and authority) as the collateral vault", async () => {
      await joinV2(wallets[3]!, 100_000_000n, 0n); // the circle USDC vault now exists
      const r = await h.refusal(joinV2(wallets[1]!, 0n, MIN, { collateralVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM) }));
      assert.equal(r, "BadCollateralVault");
    });

    it("refuses another seat's SeatCollateral address, and a program account of the wrong kind at the seat's address", async () => {
      assert.equal(await h.refusal(joinV2(wallets[1]!, 0n, MIN, { seatCollateral: seatAddress(wallets[2]!.publicKey) })), "BadSeatCollateral");
      // a Member-shaped account owned by the program at the seat's address
      const member = await h.program.coder.accounts.encode("member", {
        circle, wallet: wallets[1]!.publicKey, turn: 1, bump: 255, stockRaw: new BN(0), guarantee: new BN(0), topUps: new BN(0),
        forfeited: new BN(0), roundsPaid: 0, allocated: new BN(0), lastCoverageBps: 0,
      });
      h.putAccount(seatAddress(wallets[1]!.publicKey), member, h.program.programId);
      assert.equal(await h.refusal(joinV2(wallets[1]!, 0n, MIN)), "BadSeatCollateral");
    });

    it("refuses a SeatCollateral naming another circle at the seat's address", async () => {
      const forged = encodeSeat({ circle: anchor.web3.Keypair.generate().publicKey, wallet: wallets[1]!.publicKey, usdcLocked: 1_000n, bump: 255 });
      h.putAccount(seatAddress(wallets[1]!.publicKey), forged, h.program.programId);
      assert.equal(await h.refusal(joinV2(wallets[1]!, 0n, MIN)), "BadSeatCollateral");
    });

    it("works when someone has sent SOL to the SeatCollateral and the vault addresses first (absent = no data, any lamports)", async () => {
      for (const k of [seatAddress(wallets[1]!.publicKey), vaultAddress()]) {
        h.putAccount(k, Buffer.alloc(0), anchor.web3.SystemProgram.programId);
      }
      // putAccount gives lamports; the accounts are System-owned with no data
      await joinV2(wallets[1]!, 0n, MIN);
      assert.equal((await seat(wallets[1]!.publicKey)).usdcLocked.toString(), MIN.toString());
      await assertI4b();
    });

    it("refuses a wallet without the guarantee plus the USDC it locks (InsufficientBalance), nothing moves", async () => {
      const w = wallets[1]!;
      fund(w.publicKey, 0n, G + MIN - 1n);
      assert.equal(await h.refusal(joinV2(w, 0n, MIN)), "InsufficientBalance");
      assert.equal(await raw(vaultAddress()), null);
    });

    it("the member pays the SeatCollateral's and the vault's rent", async () => {
      const w = wallets[1]!;
      const lamports = async (k: anchor.web3.PublicKey) => BigInt((await h.context.banksClient.getAccount(k))!.lamports);
      const before = await lamports(w.publicKey);
      await joinV2(w, 0n, MIN);
      const seatRent = (await raw(seatAddress(w.publicKey)))!.lamports;
      const vaultRent = (await raw(vaultAddress()))!.lamports;
      assert.ok(before - (await lamports(w.publicKey)) >= BigInt(seatRent) + BigInt(vaultRent));
    });
  });

  describe("add_usdc_collateral", () => {
    beforeEach(async () => {
      await enable();
    });

    it("a stock seat adds USDC (Forming); a USDC seat adds more; I4b after each", async () => {
      await joinV2(wallets[1]!, 110_000_000n, 0n);
      await addUsdc(wallets[1]!, 25n * USDC);
      assert.equal((await seat(wallets[1]!.publicKey)).usdcLocked.toString(), (25n * USDC).toString());
      await assertI4b();
      await joinV2(wallets[2]!, 0n, MIN);
      await addUsdc(wallets[2]!, 5n * USDC);
      assert.equal((await seat(wallets[2]!.publicKey)).usdcLocked.toString(), (MIN + 5n * USDC).toString());
      await assertI4b();
    });

    it("refuses zero, a wallet that has not joined, a short balance, and a Cancelled circle", async () => {
      await joinV2(wallets[1]!, 110_000_000n, 0n);
      assert.equal(await h.refusal(addUsdc(wallets[1]!, 0n)), "InvalidParams");
      assert.notEqual(await h.refusal(addUsdc(wallets[2]!, USDC)), "", "a wallet with no Member must be refused");
      assert.equal(await raw(seatAddress(wallets[2]!.publicKey)), null);
      assert.equal(await h.refusal(addUsdc(wallets[1]!, 10_000n * USDC)), "InsufficientBalance");
      await call(h.program, "cancelCircle", []).accounts({ creator: wallets[0]!.publicKey, circle }).signers([wallets[0]!]).rpc();
      assert.equal(await h.refusal(addUsdc(wallets[1]!, USDC)), "CircleNotActive");
      await assertI4b();
    });

    it("a donation straight to the vault is nobody's cover and refuses nothing (I4b is a lower bound, design r9 [C32-1])", async () => {
      await joinV2(wallets[1]!, 0n, MIN);
      const DONATION = 7n * USDC + 3n;
      await donate(DONATION);
      await assertI4b(DONATION);
      // the donor's USDC does not count for the seat already holding USDC, nor for a seat joining after it
      assert.equal((await seat(wallets[1]!.publicKey)).usdcLocked, MIN);
      assert.equal(await h.refusal(joinV2(wallets[2]!, 0n, MIN - 1n)), "CollateralBelowMinimum");
      await h.nextSlot();
      await joinV2(wallets[2]!, 0n, MIN);
      await addUsdc(wallets[1]!, 5n * USDC);
      await joinV2(wallets[3]!, HALF_TOKEN, 60n * USDC);
      assert.equal((await seat(wallets[1]!.publicKey)).usdcLocked, MIN + 5n * USDC);
      assert.equal((await seat(wallets[2]!.publicKey)).usdcLocked, MIN);
      assert.equal((await seat(wallets[3]!.publicKey)).usdcLocked, 60n * USDC);
      await assertI4b(DONATION);
    });

    it("refuses a substituted vault and another seat's SeatCollateral", async () => {
      await joinV2(wallets[1]!, 110_000_000n, 0n);
      assert.equal(await h.refusal(addUsdc(wallets[1]!, USDC, { collateralVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM) })), "BadCollateralVault");
      assert.equal(await h.refusal(addUsdc(wallets[1]!, USDC, { seatCollateral: seatAddress(wallets[2]!.publicKey) })), "BadSeatCollateral");
    });
  });
});
