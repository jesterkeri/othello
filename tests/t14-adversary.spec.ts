/**
 * T14 adversary pass: attacks on init_pool, seed_pool and the upgrade-authority
 * admin root that the T14 spec does not already cover.
 *
 * Written by the adversary subagent against 0af634b, which found no defect,
 * and integrated here unchanged except for one test left out: it showed that a
 * feed's authority keeps set_prices after the upgrade authority is rotated.
 * That is current behaviour and an open design question (OPEN-QUESTIONS.md,
 * "admin rotation"), not a verdict, so it is not pinned by a passing test.
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
  UPGRADEABLE_LOADER,
  USDC,
  ataAddress,
  call,
  harness,
  initFeed,
  initPoolIx,
  poolAddress,
  priceFeedAddress,
  programDataAddress,
  seedPoolIx,
  send,
  setPrices,
  splMintAccount,
  tokenAccount,
  tokenAmount,
  type Harness,
} from "./harness.ts";

describe("T14 adversary", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;

  const newMint = (tokenProgram = SPL_TOKEN_PROGRAM): anchor.web3.PublicKey => {
    const mint = anchor.web3.Keypair.generate().publicKey;
    h.putAccount(mint, splMintAccount(6).data, new anchor.web3.PublicKey(tokenProgram));
    return mint;
  };

  const balance = async (address: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(address);
    return info ? tokenAmount(Buffer.from(info.data)) : null;
  };

  const createAta = (payer: anchor.web3.Keypair, mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, program: string) =>
    send(
      h,
      new anchor.web3.TransactionInstruction({
        programId: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: ataAddress(mint, owner, program), isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new anchor.web3.PublicKey(program), isSigner: false, isWritable: false },
        ],
        data: Buffer.alloc(0),
      }),
      payer,
    );

  const prefund = (address: anchor.web3.PublicKey) =>
    h.context.setAccount(address, {
      lamports: 1_000_000,
      data: Buffer.alloc(0),
      owner: anchor.web3.SystemProgram.programId,
      executable: false,
    });

  beforeEach(async () => {
    h = await harness(["NFLXx", "AAPLx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
    usdcMint = newMint();
    await h.setClock(BEFORE_SPLIT);
  });

  it("griefing: pool PDA and both vault addresses pre-funded with lamports, stock vault pre-created", async () => {
    const [pool] = poolAddress(h.program, usdcMint, stockMint);
    prefund(pool);
    prefund(ataAddress(usdcMint, pool, SPL_TOKEN_PROGRAM));
    await createAta(h.fund(), stockMint, pool, TOKEN_2022_PROGRAM);

    await initPoolIx(h, { usdcMint, stockMint, discountBps: 2000 }).rpc();
    assert.ok(await h.context.banksClient.getAccount(pool));
  });

  it("griefing: feed PDA pre-funded with lamports", async () => {
    prefund(priceFeedAddress(h.program, stockMint));
    await initFeed(h, stockMint);
  });

  it("Token-2022 USDC declared as SPL token program is refused", async () => {
    const t22 = newMint(TOKEN_2022_PROGRAM);
    const r = await h.refusal(initPoolIx(h, { usdcMint: t22, stockMint, discountBps: 2000 }).rpc());
    assert.notEqual(r, "", "refused");
    assert.equal(await h.context.banksClient.getAccount(poolAddress(h.program, t22, stockMint)[0]), null);
  });

  it("a different executable passed as `program` is refused", async () => {
    const stranger = h.fund();
    const ix = call(h.program, "initPriceFeed").accounts({
      authority: stranger.publicKey,
      program: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      programData: programDataAddress(h.program.programId),
      stockMint,
      feed: priceFeedAddress(h.program, stockMint),
    });
    await assert.rejects(ix.signers([stranger]).rpc());
  });

  it("a Buffer account (tag 1) naming the stranger as authority is refused as ProgramData", async () => {
    const stranger = h.fund();
    const buf = anchor.web3.Keypair.generate().publicKey;
    const data = Buffer.alloc(37 + 8);
    data.writeUInt32LE(1, 0);
    data[4] = 1;
    stranger.publicKey.toBuffer().copy(data, 5);
    h.putAccount(buf, data, UPGRADEABLE_LOADER);
    await assert.rejects(
      initPoolIx(h, { usdcMint, stockMint, discountBps: 2000, signer: stranger, programData: buf }).rpc(),
    );
  });

  it("seed_pool from an account the authority is only DELEGATE on is refused", async () => {
    await initPoolIx(h, { usdcMint, stockMint, discountBps: 2000 }).rpc();
    const [pool] = poolAddress(h.program, usdcMint, stockMint);
    const victim = anchor.web3.Keypair.generate().publicKey;
    const victimAta = ataAddress(usdcMint, victim, SPL_TOKEN_PROGRAM);
    const acct = tokenAccount({ mint: usdcMint, owner: victim, amount: 100n * BigInt(USDC), tokenProgram: SPL_TOKEN_PROGRAM });
    acct.data.writeUInt32LE(1, 72);
    h.authority.publicKey.toBuffer().copy(acct.data, 76);
    acct.data.writeBigUInt64LE(100n * BigInt(USDC), 121);
    h.putAccount(victimAta, acct.data, acct.owner);

    const ix = call(h.program, "seedPool", [new BN(10 * USDC)])
      .accounts({
        authority: h.authority.publicKey,
        pool,
        usdcMint,
        stockMint,
        authorityUsdc: victimAta,
        poolUsdcVault: ataAddress(usdcMint, pool, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([h.authority]);
    await assert.rejects(ix.rpc());
    assert.equal(await balance(victimAta), 100n * BigInt(USDC));
  });

  it("seed_pool into a non-ATA token account owned by the pool is refused", async () => {
    await initPoolIx(h, { usdcMint, stockMint, discountBps: 2000 }).rpc();
    const [pool] = poolAddress(h.program, usdcMint, stockMint);
    const stray = anchor.web3.Keypair.generate().publicKey;
    const a = tokenAccount({ mint: usdcMint, owner: pool, amount: 0n, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(stray, a.data, a.owner);
    const own = tokenAccount({ mint: usdcMint, owner: h.authority.publicKey, amount: 50n * BigInt(USDC), tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(ataAddress(usdcMint, h.authority.publicKey, SPL_TOKEN_PROGRAM), own.data, own.owner);
    const ix = call(h.program, "seedPool", [new BN(10 * USDC)])
      .accounts({
        authority: h.authority.publicKey,
        pool,
        usdcMint,
        stockMint,
        authorityUsdc: ataAddress(usdcMint, h.authority.publicKey, SPL_TOKEN_PROGRAM),
        poolUsdcVault: stray,
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([h.authority]);
    await assert.rejects(ix.rpc());
  });

  it("seed_pool against another pair's pool with this pair's mints is refused (seeds)", async () => {
    const other = newMint();
    await initPoolIx(h, { usdcMint: other, stockMint, discountBps: 2000 }).rpc();
    const [otherPool] = poolAddress(h.program, other, stockMint);
    const own = tokenAccount({ mint: usdcMint, owner: h.authority.publicKey, amount: 50n * BigInt(USDC), tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(ataAddress(usdcMint, h.authority.publicKey, SPL_TOKEN_PROGRAM), own.data, own.owner);
    const ix = call(h.program, "seedPool", [new BN(10 * USDC)])
      .accounts({
        authority: h.authority.publicKey,
        pool: otherPool,
        usdcMint,
        stockMint,
        authorityUsdc: ataAddress(usdcMint, h.authority.publicKey, SPL_TOKEN_PROGRAM),
        poolUsdcVault: ataAddress(usdcMint, otherPool, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([h.authority]);
    await assert.rejects(ix.rpc());
  });

  it("second init_pool for the same pair is refused (no overwrite of discount)", async () => {
    await initPoolIx(h, { usdcMint, stockMint, discountBps: 2000 }).rpc();
    await assert.rejects(initPoolIx(h, { usdcMint, stockMint, discountBps: 0 }).rpc());
  });

  it("harness sanity: the program really runs from the ProgramData ELF (changing authority byte changes outcome)", async () => {
    const pd = programDataAddress(h.program.programId);
    const info = await h.context.banksClient.getAccount(pd);
    assert.ok(info);
    const data = Buffer.from(info.data);
    const newAdmin = h.fund();
    newAdmin.publicKey.toBuffer().copy(data, 13);
    h.putAccount(pd, data, UPGRADEABLE_LOADER);
    assert.equal(await h.refusal(initFeed(h, stockMint)), "Unauthorized");
    await initFeed(h, stockMint, newAdmin);
  });
});
