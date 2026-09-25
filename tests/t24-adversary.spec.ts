/**
 * T24 adversary: attacks on ops/demo.ts's seed and split, against the devnet
 * build in bankrun. Same Chain as tests/t24-seed-demo.spec.ts.
 *
 * Requirement under test (SPEC.md:137 and TASKS T24): all five members join
 * BEFORE the split is scheduled, and the seed is safe to re-run: a run that
 * stopped half way is finished by running it again.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, decodeValuation, fetchAccount, harness, quoteIx, send, type Harness } from "./harness.ts";
import { DEMO, addresses, scheduleSplit, seedDemoCircle, type Chain } from "../ops/demo.ts";
import {
  NFLXX_MIRROR_SPACE,
  TEST_USDC_SPACE,
  createDevnetMintsIxs,
  devnetMintAddresses,
} from "../ops/devnet-mints.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

describe("T24 adversary: split scheduled while the seed is unfinished", () => {
  let h: Harness;
  let chain: Chain;
  let members: anchor.web3.Keypair[];

  before(function () {
    this.timeout(600_000);
    const built = spawnSync(
      "cargo",
      ["build-sbf", "--manifest-path", "programs/othello/Cargo.toml", "--features", "devnet", "--sbf-out-dir", "target/devnet"],
      { cwd: REPO, env: { ...process.env, PATH: TOOLCHAIN_PATH }, encoding: "utf8" },
    );
    assert.equal(built.status, 0, `devnet build failed: ${built.stderr || built.error}`);
  });

  beforeEach(async () => {
    h = await harness([], DEVNET_SO);
    await h.setClock(BEFORE_SPLIT);
    const rent = await h.context.banksClient.getRent();
    const tx = new anchor.web3.Transaction().add(
      ...(await createDevnetMintsIxs(h.authority.publicKey, {
        nflxxMirror: Number(rent.minimumBalance(BigInt(NFLXX_MIRROR_SPACE))),
        testUsdc: Number(rent.minimumBalance(BigInt(TEST_USDC_SPACE))),
      })),
    );
    tx.recentBlockhash = h.context.lastBlockhash;
    tx.feePayer = h.authority.publicKey;
    tx.sign(h.authority);
    await h.context.banksClient.processTransaction(tx);
    const made = await devnetMintAddresses(h.authority.publicKey);
    for (const [from, to] of [[made.nflxxMirror, MINTS.stock], [made.testUsdc, MINTS.usdc]] as const) {
      const info = (await h.context.banksClient.getAccount(from))!;
      h.putAccount(to, Buffer.from(info.data), info.owner);
    }
    chain = {
      program: h.program,
      admin: h.authority,
      send: async (ixs, signers) => {
        await h.nextSlot();
        const t = new anchor.web3.Transaction().add(...ixs);
        t.recentBlockhash = h.context.lastBlockhash;
        t.feePayer = signers[0]!.publicKey;
        t.sign(...signers);
        await h.context.banksClient.processTransaction(t);
      },
      getAccount: async (address) => {
        const info = await h.context.banksClient.getAccount(address);
        return info ? { lamports: Number(info.lamports), data: Buffer.from(info.data), owner: info.owner } : null;
      },
      now: async () => Number((await h.context.banksClient.getClock()).unixTimestamp),
      log: () => {},
    };
    members = Array.from({ length: DEMO.n }, () => anchor.web3.Keypair.generate());
  });

  const quoteH = async () =>
    decodeValuation(await send(h, await quoteIx(h, MINTS.stock, { raw: DEMO.lockRaw.toString(), haircutBps: DEMO.haircutBps, maxPriceAge: DEMO.maxPriceAge }))).h;

  it("a seed that stopped after the prices is either protected from the split or still finishable after it", async () => {
    // The seed stops at its third send (feed created and prices set 150/150 at
    // 1.0; init_pool is the send that drops), before the pool, the members or
    // the circle exist.
    const real = chain.send;
    let calls = 0;
    chain.send = async (ixs, signers) => {
      if (++calls === 3) throw new Error("simulated dropped RPC");
      await real(ixs, signers);
    };
    await assert.rejects(seedDemoCircle(chain, MINTS, members), /simulated dropped RPC/);
    chain.send = real;

    // The split is scheduled now (schedule-split.ts). SPEC.md:137 needs every
    // member joined first; nobody has joined.
    const now = await chain.now();
    let scheduled = true;
    try {
      await scheduleSplit(chain, MINTS, members[0]!.publicKey, now + 120);
    } catch {
      scheduled = false; // a guard refused it: the requirement holds.
    }

    if (scheduled) {
      // Past the effective time the mirror is at 10x and the feed is priced for
      // 10x, so nothing is Repricing any more. The re-run must finish the seed.
      await h.setClock(now + 121);
      await h.nextSlot();
    }
    const rerunSends: string[] = [];
    chain.send = async (ixs, signers) => {
      rerunSends.push(ixs.map((ix) => (ix.programId.equals(h.program.programId) ? `othello:${ix.data.subarray(0, 8).toString("hex")}` : ix.programId.toBase58().slice(0, 8))).join(","));
      await real(ixs, signers);
    };
    const setPricesDisc = (h.program.idl.instructions.find((i) => i.name === "setPrices" || i.name === "set_prices")!.discriminator as number[]);
    let circle: anchor.web3.PublicKey;
    try {
      circle = await seedDemoCircle(chain, MINTS, members);
    } catch (e) {
      assert.fail(
        `split scheduled=${scheduled}; the re-run of the seed failed on send #${rerunSends.length} [${rerunSends.at(-1)}] ` +
          `(set_prices is othello:${Buffer.from(setPricesDisc).toString("hex")}): ${(e as Error).message}`,
      );
    }
    const c = await fetchAccount<{ status: Record<string, unknown> }>(h.program, "circle", circle);
    assert.ok("active" in c.status, `circle is ${JSON.stringify(c.status)}`);
    assert.equal(await quoteH(), 132_000_000n);
    assert.ok(addresses(h.program, MINTS, members[0]!.publicKey).circle.equals(circle));
  });

  it("members funded by the seed can pay every round and release every pot on their own SOL and USDC", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    const a = addresses(h.program, MINTS, members[0]!.publicKey);
    const SPL = new anchor.web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const T22 = new anchor.web3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const ATA = new anchor.web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const ata = (mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, prog: anchor.web3.PublicKey) =>
      anchor.web3.PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA)[0];
    const m = h.program.methods as unknown as Record<string, (...x: unknown[]) => { accounts(a: unknown): { remainingAccounts(r: unknown): { instruction(): Promise<anchor.web3.TransactionInstruction> }; instruction(): Promise<anchor.web3.TransactionInstruction> } }>;
    const lam = async (k: anchor.web3.PublicKey) => Number((await h.context.banksClient.getAccount(k))?.lamports ?? 0);
    const after = await Promise.all(members.map((w) => lam(w.publicKey)));
    console.log(`      member lamports after seed: ${after.join(", ")}`);
    const metas = members.map((w) => ({ pubkey: a.member(w.publicKey), isWritable: true, isSigner: false }));
    for (let round = 0; round < DEMO.n; round++) {
      for (const w of members) {
        const ix = await m.contribute!().accounts({
          wallet: w.publicKey, circle, member: a.member(w.publicKey), usdcMint: MINTS.usdc,
          memberUsdcAta: ata(MINTS.usdc, w.publicKey, SPL), circleUsdcVault: ata(MINTS.usdc, circle, SPL), usdcTokenProgram: SPL,
        }).instruction();
        await chain.send([ix], [w]);
      }
      const recipient = members[round]!;
      const ix = await m.releasePot!().accounts({
        caller: recipient.publicKey, circle, stockMint: MINTS.stock, usdcMint: MINTS.usdc, priceFeed: a.feed,
        recipient: recipient.publicKey, recipientUsdcAta: ata(MINTS.usdc, recipient.publicKey, SPL),
        circleUsdcVault: ata(MINTS.usdc, circle, SPL), usdcTokenProgram: SPL, associatedTokenProgram: ATA,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).remainingAccounts(metas).instruction();
      await chain.send([ix], [recipient]);
    }
    const c = await fetchAccount<{ status: Record<string, unknown> }>(h.program, "circle", circle);
    assert.ok("completed" in c.status, JSON.stringify(c.status));
    console.log(`      member lamports at completion: ${(await Promise.all(members.map((w) => lam(w.publicKey)))).join(", ")}`);
    void T22;
  });

  it("a finished seed sends nothing, even after the demo has played a default", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    const a = addresses(h.program, MINTS, members[0]!.publicKey);
    const SPL = new anchor.web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const T22 = new anchor.web3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const ATA = new anchor.web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const ata = (mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, prog: anchor.web3.PublicKey) =>
      anchor.web3.PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA)[0];
    type B = { accounts(a: unknown): B; remainingAccounts(r: unknown): B; instruction(): Promise<anchor.web3.TransactionInstruction> };
    const m = h.program.methods as unknown as Record<string, (...x: unknown[]) => B>;
    const metas = members.map((w) => ({ pubkey: a.member(w.publicKey), isWritable: true, isSigner: false }));
    // Round 0: everyone pays, member 1 receives.
    for (const w of members) {
      await chain.send([await m.contribute!().accounts({
        wallet: w.publicKey, circle, member: a.member(w.publicKey), usdcMint: MINTS.usdc,
        memberUsdcAta: ata(MINTS.usdc, w.publicKey, SPL), circleUsdcVault: ata(MINTS.usdc, circle, SPL), usdcTokenProgram: SPL,
      }).instruction()], [w]);
    }
    await chain.send([await m.releasePot!().accounts({
      caller: h.authority.publicKey, circle, stockMint: MINTS.stock, usdcMint: MINTS.usdc, priceFeed: a.feed,
      recipient: members[0]!.publicKey, recipientUsdcAta: ata(MINTS.usdc, members[0]!.publicKey, SPL),
      circleUsdcVault: ata(MINTS.usdc, circle, SPL), usdcTokenProgram: SPL, associatedTokenProgram: ATA,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).remainingAccounts(metas).instruction()], [h.authority]);
    // Round 1: member 1 (already paid out) misses; past deadline + grace, anyone declares the default.
    await h.setClock((await chain.now()) + DEMO.roundSecs + DEMO.graceSecs + 1);
    await chain.send([await m.declareDefault!(0).accounts({
      caller: h.authority.publicKey, circle, stockMint: MINTS.stock, usdcMint: MINTS.usdc, priceFeed: a.feed, pool: a.pool,
      circleStockVault: ata(MINTS.stock, circle, T22), circleUsdcVault: ata(MINTS.usdc, circle, SPL),
      poolStockVault: ata(MINTS.stock, a.pool, T22), poolUsdcVault: ata(MINTS.usdc, a.pool, SPL),
      stockTokenProgram: T22, usdcTokenProgram: SPL,
    }).remainingAccounts(metas).instruction()], [h.authority]);

    // The seed is finished (circle Active, all five joined). A re-run must send nothing.
    const sends: string[] = [];
    const real = chain.send;
    chain.send = async (ixs, signers) => {
      sends.push(ixs.map((ix) => ix.programId.toBase58().slice(0, 8)).join(","));
      await real(ixs, signers);
    };
    await seedDemoCircle(chain, MINTS, members);
    assert.deepEqual(sends, [], "the re-run of a finished seed sent transactions");
  });
});
