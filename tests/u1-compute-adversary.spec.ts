/**
 * U1 adversary: join_and_lock_v2 against NFR-3 (SPEC.md:24, "Every instruction fits in the default 200k CU").
 *
 * A member who locks USDC only usually holds no NFLXx, so join_and_lock_v2 creates their stock ATA, and the first
 * joiner also creates both circle vaults, the collateral vault and the SeatCollateral. The handler then derives the
 * SeatCollateral and collateral vault PDAs with find_program_address three times each (join's union reads, then
 * lock_usdc's reads, then lock_usdc's bump lookups). Each find costs 1,500 CU per bump tried, so the cost depends on
 * the circle and wallet keys. In a probe on this build about 1 in 20 random (circle, wallet) pairs needed more than
 * 200,000 CU for this join (3 of 60).
 *
 * The keys below are deterministic (sha256 seeds, searched over member index and circle id). Every other PDA and ATA
 * involved has the best-case bump 255; only the SeatCollateral (248) and the collateral vault (250) are in the tail
 * (1 in 128 and 1 in 32). Deriving each of those two once instead of three times saves about 40,000 CU, which brings
 * this exact join well under the budget.
 *
 * The join is sent exactly as a wallet sends it, with no compute-budget instruction.
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
/** SPEC.md:137's demo circle, as u1-usdc-collateral-join.spec.ts uses it. */
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
/** Found by search over `othello u1 adversary: member ${i}` and circle ids (see the header). */
const CREATOR_SEED = "othello u1 adversary: creator";
const MEMBER_SEED = "othello u1 adversary: member 0";
const CIRCLE_ID = 10691n;
/**
 * The compute limit slice 4's builder prepends to join_and_lock_v2 (design r9 [R3-3], [C32-2]; SPEC NFR-3). Measured
 * maximum 199,881 here and 218,636 with every created address pre-funded (u1-compute-probe-adversary).
 */
const JOIN_V2_CU_LIMIT = 300_000;
/** SPEC NFR-3 / design r9 [R3-3]: a builder's limit is at least the measured maximum + 20%, rounded up to 10,000. */
const ruleLimit = (max: number) => Math.ceil((max * 1.2) / 10_000) * 10_000;

describe("U1 adversary: join_and_lock_v2 fits the default compute budget (NFR-3)", () => {
  let h: Harness;
  const stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
  const usdcMint = APPROVED_USDC;

  const pda = (seeds: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(seeds, h.program.programId);

  it("a USDC-only first join by a member with no stock account succeeds without a compute-budget instruction", async () => {
    h = await harness(["NFLXx"]);
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);
    const [pool, poolBump] = poolAddress(h.program, usdcMint, stockMint);
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", { authority: h.authority.publicKey, bump: poolBump, discountBps: 2000 }),
      h.program.programId,
    );
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: 150 * 1_000_000, share: 150 * 1_000_000, stamp: CURRENT, expected: ONE_X });

    const features = pda([Buffer.from("features")])[0];
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

    const creator = h.fund(anchor.web3.LAMPORTS_PER_SOL, anchor.web3.Keypair.fromSeed(seed(CREATOR_SEED)));
    const member = h.fund(anchor.web3.LAMPORTS_PER_SOL, anchor.web3.Keypair.fromSeed(seed(MEMBER_SEED)));
    const other = h.fund();
    const circle = circleAddress(h.program, creator.publicKey, CIRCLE_ID);

    await call(h.program, "createCircle", [
      {
        circleId: new BN(CIRCLE_ID.toString()),
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
      [creator.publicKey, other.publicKey, member.publicKey],
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

    // A USDC-only member: a USDC account with the guarantee plus the minimum cover, and no NFLXx account at all.
    const u = tokenAccount({ mint: usdcMint, owner: member.publicKey, amount: G + 500n * USDC, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(ataAddress(usdcMint, member.publicKey, SPL_TOKEN_PROGRAM), u.data, u.owner);

    const seat = pda([Buffer.from("seat_usdc"), circle.toBuffer(), member.publicKey.toBuffer()]);
    const vault = pda([Buffer.from("usdc_collateral"), circle.toBuffer()]);
    // The keys are what make this case: both PDAs the handler re-derives sit in the tail of bump searches.
    assert.equal(seat[1], 248);
    assert.equal(vault[1], 250);

    const ix = await call(h.program, "joinAndLockV2", [new BN(0), new BN(MIN.toString())])
      .accounts({
        wallet: member.publicKey,
        circle,
        member: pda([Buffer.from("member"), circle.toBuffer(), member.publicKey.toBuffer()])[0],
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        memberStockAta: ataAddress(stockMint, member.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, member.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        seatCollateral: seat[0],
        collateralVault: vault[0],
        features,
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    const blockhash = (await h.context.banksClient.getLatestBlockhash())![0];
    const build = (withBudget: boolean) => {
      const tx = new anchor.web3.Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = member.publicKey;
      if (withBudget) tx.add(anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
      tx.add(ix);
      tx.sign(member);
      return tx;
    };

    // What the join really costs, measured with room to spare (simulation only, nothing lands).
    const sim = await h.context.banksClient.simulateTransaction(build(true));
    assert.equal(sim.result, null, `the join itself must be valid: ${String(sim.result)}`);
    const needed = sim.meta!.computeUnitsConsumed;

    // As a wallet sends it.
    const r = await h.context.banksClient.tryProcessTransaction(build(false));
    assert.equal(
      r.result,
      null,
      `NFR-3: join_and_lock_v2 needs ${needed} CU here, over the default 200,000: ${String(r.result)}`,
    );
    const locked = (await h.context.banksClient.getAccount(seat[0]))!;
    assert.equal(Buffer.from(locked.data).readBigUInt64LE(72), MIN);
    assert.equal(tokenAmount(Buffer.from((await h.context.banksClient.getAccount(vault[0]))!.data)), MIN);
  });

  /**
   * After the fix (each new PDA found once) the adversary's pair fits the default budget, but the cost of a USDC-only
   * FIRST join still depends on the keys: 10 address searches (member PDA, four ATAs checked, three ATAs created,
   * SeatCollateral, collateral vault) at 1,500 CU per bump tried. Measured over these 200 pairs: max 199,860, so the
   * tail can cross 200,000. Design r8 [R3-3]: "If any exceeds it, the builders that send it prepend
   * setComputeUnitLimit"; slice 4's builder does that for join_and_lock_v2 with JOIN_V2_CU_LIMIT, and the r8 decoder
   * reads the Othello instruction at its compiled index. This test pins the spread under that limit.
   */
  it("compute across 200 fixed (circle, member) key pairs: every USDC-only first join stays under JOIN_V2_CU_LIMIT", async function () {
    this.timeout(1_800_000);
    h = await harness(["NFLXx"]);
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);
    const [pool, poolBump] = poolAddress(h.program, usdcMint, stockMint);
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", { authority: h.authority.publicKey, bump: poolBump, discountBps: 2000 }),
      h.program.programId,
    );
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: 150 * 1_000_000, share: 150 * 1_000_000, stamp: CURRENT, expected: ONE_X });
    const features = pda([Buffer.from("features")])[0];
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

    const used: number[] = [];
    for (let i = 0; i < 200; i++) {
      const creator = h.fund(anchor.web3.LAMPORTS_PER_SOL, anchor.web3.Keypair.fromSeed(seed(`othello u1 sweep: creator ${i}`)));
      const member = h.fund(anchor.web3.LAMPORTS_PER_SOL, anchor.web3.Keypair.fromSeed(seed(`othello u1 sweep: member ${i}`)));
      const other = h.fund();
      const circle = circleAddress(h.program, creator.publicKey, 0n);
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
        [creator.publicKey, other.publicKey, member.publicKey],
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
      const u = tokenAccount({ mint: usdcMint, owner: member.publicKey, amount: G + 500n * USDC, tokenProgram: SPL_TOKEN_PROGRAM });
      h.putAccount(ataAddress(usdcMint, member.publicKey, SPL_TOKEN_PROGRAM), u.data, u.owner);
      const ix = await call(h.program, "joinAndLockV2", [new BN(0), new BN(MIN.toString())])
        .accounts({
          wallet: member.publicKey,
          circle,
          member: pda([Buffer.from("member"), circle.toBuffer(), member.publicKey.toBuffer()])[0],
          stockMint,
          usdcMint,
          priceFeed: priceFeedAddress(h.program, stockMint),
          memberStockAta: ataAddress(stockMint, member.publicKey, TOKEN_2022_PROGRAM),
          memberUsdcAta: ataAddress(usdcMint, member.publicKey, SPL_TOKEN_PROGRAM),
          circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
          circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
          seatCollateral: pda([Buffer.from("seat_usdc"), circle.toBuffer(), member.publicKey.toBuffer()])[0],
          collateralVault: pda([Buffer.from("usdc_collateral"), circle.toBuffer()])[0],
          features,
          stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
          usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
          associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction();
      await h.nextSlot();
      const tx = new anchor.web3.Transaction();
      tx.recentBlockhash = (await h.context.banksClient.getLatestBlockhash())![0];
      tx.feePayer = member.publicKey;
      tx.add(ix);
      tx.sign(member);
      const r = await h.context.banksClient.tryProcessTransaction(tx);
      assert.equal(r.result, null, `pair ${i}: ${String(r.result)}`);
      used.push(Number(r.meta!.computeUnitsConsumed));
    }
    used.sort((a, b) => a - b);
    const at = (q: number) => used[Math.min(used.length - 1, Math.floor(q * used.length))]!;
    console.log(`      USDC-only first join, 200 pairs: min ${used[0]}, median ${at(0.5)}, p95 ${at(0.95)}, max ${used[used.length - 1]} CU`);
    assert.ok(used[used.length - 1]! < JOIN_V2_CU_LIMIT, `max ${used[used.length - 1]} is over the builder's limit`);
    assert.ok(JOIN_V2_CU_LIMIT >= ruleLimit(used[used.length - 1]!), `max ${used[used.length - 1]} needs a limit of ${ruleLimit(used[used.length - 1]!)} (NFR-3)`);
  });
});
