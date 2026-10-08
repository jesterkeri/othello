/**
 * Adversary r2 on 5c048be (USDC slice 1): compute of the slice-1 instructions over 60 fixed key pairs, with every
 * address each instruction creates pre-funded with 1 lamport by a stranger (the slower create path). Bounds: SPEC.md:24
 * NFR-3's default 200,000 for join_and_lock and add_usdc_collateral; join_and_lock_v2 under JOIN_V2_CU_LIMIT, the
 * limit slice 4's builder prepends (design r8 [R3-3]). Measured at 5c048be: v2 USDC-only max 218,615; stock+USDC
 * 178,679; legacy 156,438; add 60,673.
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
const MIN = BigInt(DEMO.minStockCover);
const G = BigInt(DEMO.guaranteePerMember);
const seed = (s: string) => createHash("sha256").update(s).digest();

const JOIN_V2_CU_LIMIT = 300_000;
const DEFAULT_CU = 200_000;

describe("U1 adversary r2: slice-1 compute with every created address pre-funded", () => {
  let h: Harness;
  const stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
  const usdcMint = APPROVED_USDC;
  const pda = (seeds: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(seeds, h.program.programId);
  let features: anchor.web3.PublicKey;
  let pool: anchor.web3.PublicKey;

  const grief = (k: anchor.web3.PublicKey) =>
    h.context.setAccount(k, { lamports: 1, data: Buffer.alloc(0), owner: anchor.web3.SystemProgram.programId, executable: false });

  async function setup() {
    h = await harness(["NFLXx"]);
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);
    const [p, poolBump] = poolAddress(h.program, usdcMint, stockMint);
    pool = p;
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", { authority: h.authority.publicKey, bump: poolBump, discountBps: 2000 }),
      h.program.programId,
    );
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: 150 * 1_000_000, share: 150 * 1_000_000, stamp: CURRENT, expected: ONE_X });
    features = pda([Buffer.from("features")])[0];
    await call(h.program, "enableUsdcCollateral", [])
      .accounts({
        authority: h.authority.publicKey,
        program: h.program.programId,
        programData: programDataAddress(h.program.programId),
        features,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([h.authority])
      .rpc();
  }

  async function newCircle(creator: anchor.web3.Keypair, members: anchor.web3.PublicKey[], id: bigint) {
    const circle = circleAddress(h.program, creator.publicKey, id);
    await call(h.program, "createCircle", [
      {
        circleId: new BN(id.toString()),
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
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    return circle;
  }

  const v2Accounts = (circle: anchor.web3.PublicKey, w: anchor.web3.PublicKey) => ({
    wallet: w,
    circle,
    member: pda([Buffer.from("member"), circle.toBuffer(), w.toBuffer()])[0],
    stockMint,
    usdcMint,
    priceFeed: priceFeedAddress(h.program, stockMint),
    memberStockAta: ataAddress(stockMint, w, TOKEN_2022_PROGRAM),
    memberUsdcAta: ataAddress(usdcMint, w, SPL_TOKEN_PROGRAM),
    circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
    circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
    seatCollateral: pda([Buffer.from("seat_usdc"), circle.toBuffer(), w.toBuffer()])[0],
    collateralVault: pda([Buffer.from("usdc_collateral"), circle.toBuffer()])[0],
    features,
    stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
    usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
    associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
    systemProgram: anchor.web3.SystemProgram.programId,
  });

  async function cu(ix: anchor.web3.TransactionInstruction, signer: anchor.web3.Keypair) {
    await h.nextSlot();
    const tx = new anchor.web3.Transaction();
    tx.recentBlockhash = (await h.context.banksClient.getLatestBlockhash())![0];
    tx.feePayer = signer.publicKey;
    tx.add(anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx.add(ix);
    tx.sign(signer);
    const r = await h.context.banksClient.tryProcessTransaction(tx);
    if (r.result !== null) throw new Error(`${String(r.result)}\n${r.meta?.logMessages.join("\n")}`);
    return Number(r.meta!.computeUnitsConsumed) - 150;
  }

  it("60 key pairs: join_and_lock and add_usdc_collateral fit the default; join_and_lock_v2 fits the builder's limit", async function () {
    this.timeout(1_800_000);
    await setup();
    const out: Record<string, number[]> = { v2clean: [], v2grief: [], legacyGrief: [], addGrief: [], bothGrief: [] };
    for (let i = 0; i < 60; i++) {
      const creator = h.fund(anchor.web3.LAMPORTS_PER_SOL, anchor.web3.Keypair.fromSeed(seed(`othello u1 sweep: creator ${i}`)));
      const member = h.fund(anchor.web3.LAMPORTS_PER_SOL, anchor.web3.Keypair.fromSeed(seed(`othello u1 sweep: member ${i}`)));
      const m2 = h.fund(anchor.web3.LAMPORTS_PER_SOL);
      const m3 = h.fund(anchor.web3.LAMPORTS_PER_SOL);
      // Circle A: USDC-only first join, griefed (all six created addresses pre-funded with 1 lamport)
      const cA = await newCircle(creator, [creator.publicKey, member.publicKey, m2.publicKey], 0n);
      const u = tokenAccount({ mint: usdcMint, owner: member.publicKey, amount: G * 4n + 1000n * USDC, tokenProgram: SPL_TOKEN_PROGRAM });
      h.putAccount(ataAddress(usdcMint, member.publicKey, SPL_TOKEN_PROGRAM), u.data, u.owner);
      const accA = v2Accounts(cA, member.publicKey);
      for (const k of [accA.member, accA.memberStockAta, accA.circleStockVault, accA.circleUsdcVault, accA.seatCollateral, accA.collateralVault]) grief(k);
      out.v2grief!.push(await cu(await call(h.program, "joinAndLockV2", [new BN(0), new BN(MIN.toString())]).accounts(accA).instruction(), member));

      // Circle B: legacy first join, griefed; then add_usdc_collateral first add, griefed; then a both-asset join griefed
      const cB = await newCircle(creator, [creator.publicKey, member.publicKey, m2.publicKey, m3.publicKey], 1n);
      const s = tokenAccount({ mint: stockMint, owner: member.publicKey, amount: 500_000_000n, tokenProgram: TOKEN_2022_PROGRAM });
      h.putAccount(ataAddress(stockMint, member.publicKey, TOKEN_2022_PROGRAM), s.data, s.owner);
      const accB = v2Accounts(cB, member.publicKey);
      for (const k of [accB.member, accB.circleStockVault, accB.circleUsdcVault]) grief(k);
      const { seatCollateral: _s, collateralVault: _v, features: _f, ...legacy } = accB;
      out.legacyGrief!.push(await cu(await call(h.program, "joinAndLock", [new BN(110_000_000)]).accounts(legacy).instruction(), member));
      grief(accB.seatCollateral);
      grief(accB.collateralVault);
      out.addGrief!.push(
        await cu(
          await call(h.program, "addUsdcCollateral", [new BN(1)])
            .accounts({
              wallet: member.publicKey,
              circle: cB,
              member: accB.member,
              seatCollateral: accB.seatCollateral,
              collateralVault: accB.collateralVault,
              features,
              usdcMint,
              memberUsdcAta: accB.memberUsdcAta,
              usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
          member,
        ),
      );
      // Circle C: both-asset first join, griefed
      const cC = await newCircle(creator, [creator.publicKey, member.publicKey, m2.publicKey], 2n);
      const accC = v2Accounts(cC, member.publicKey);
      for (const k of [accC.member, accC.circleStockVault, accC.circleUsdcVault, accC.seatCollateral, accC.collateralVault]) grief(k);
      out.bothGrief!.push(await cu(await call(h.program, "joinAndLockV2", [new BN(50_000_000), new BN((60n * USDC).toString())]).accounts(accC).instruction(), member));
    }
    for (const [k, v] of Object.entries(out)) {
      if (!v.length) continue;
      v.sort((a, b) => a - b);
      console.log(`      ${k}: n ${v.length}, min ${v[0]}, median ${v[Math.floor(v.length / 2)]}, max ${v[v.length - 1]}`);
    }
    const max = (k: string) => out[k]![out[k]!.length - 1]!;
    assert.ok(max("v2grief") < JOIN_V2_CU_LIMIT, `USDC-only join ${max("v2grief")}`);
    assert.ok(max("bothGrief") < JOIN_V2_CU_LIMIT, `stock+USDC join ${max("bothGrief")}`);
    assert.ok(max("legacyGrief") < DEFAULT_CU, `legacy join ${max("legacyGrief")}`);
    assert.ok(max("addGrief") < DEFAULT_CU, `add_usdc_collateral ${max("addGrief")}`);
  });
});
