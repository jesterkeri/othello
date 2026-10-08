/**
 * PR 2 (Joshua 2026-10-08): the forming circle's own steps on Solana, as the app builds them (app/src/lib/actions.ts
 * joinAndLockIx, leaveFormingIx, activateIx, cancelCircleIx), sent to the DEVNET build in bankrun after the real demo
 * seed left Forming (ops/demo.ts seedDemoCircle with `joined`). And the app's least join stock (lib/circle.ts
 * minJoinStock) against the program's own CollateralBelowMinimum check. Harness: tests/app-actions.spec.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, fetchAccount, harness, type Harness } from "./harness.ts";
import { DEMO, seedDemoCircle, type Chain } from "../ops/demo.ts";
import { NFLXX_MIRROR_DECIMALS, NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_DECIMALS, TEST_USDC_SPACE, TOKEN_2022, ataAddress, createAtaIdempotentIx, createDevnetMintsIxs, devnetMintAddresses, mintToCheckedIx } from "../ops/devnet-mints.ts";
import { explainFailure } from "../app/src/lib/contribute.ts";
import { activateIx, cancelCircleIx, joinAndLockIx, leaveFormingIx, withdrawIx, type CircleKeys } from "../app/src/lib/actions.ts";
import { countedOfRaw, minJoinStock } from "../app/src/lib/circle.ts";
import { joinLamports } from "../app/src/lib/solana-join.ts";
import { decodeLive, memberAddress } from "../app/src/lib/live.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

describe("PR 2: join, leave, start and cancel on a forming Solana circle, as the app builds them", () => {
  let h: Harness;
  let chain: Chain;
  let members: anchor.web3.Keypair[];
  let sent: number;

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

    // Real mint bytes at the devnet addresses, with h.authority as their mint
    // authority, exactly as ops/create-devnet-mints.ts leaves them for the admin.
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

    sent = 0;
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
        sent++;
      },
      getAccount: async (address) => {
        const info = await h.context.banksClient.getAccount(address);
        return info ? { lamports: Number(info.lamports), data: Buffer.from(info.data), owner: info.owner } : null;
      },
      now: async () => Number((await h.context.banksClient.getClock()).unixTimestamp),
      log: () => {},
    };
    // Members start with nothing: the seed must fund them itself.
    members = Array.from({ length: DEMO.n }, () => anchor.web3.Keypair.generate());
  });

  const sendAs = async (ix: anchor.web3.TransactionInstruction, signer: anchor.web3.Keypair) => {
    await h.nextSlot();
    const t = new anchor.web3.Transaction().add(ix);
    t.recentBlockhash = h.context.lastBlockhash;
    t.feePayer = signer.publicKey;
    t.sign(signer);
    await h.context.banksClient.processTransaction(t);
  };
  type Round = { round: number; paidBitmap: number; receivedBitmap: number; defaultedBitmap: number; lastCoverageAt: anchor.BN; roundDeadline: anchor.BN; graceSecs: anchor.BN; status: object };
  const read = (circle: anchor.web3.PublicKey) => fetchAccount<Round>(h.program, "circle", circle);
  const keys = (circle: anchor.web3.PublicKey): CircleKeys => ({ circle, usdcMint: MINTS.usdc, stockMint: MINTS.stock, members: members.map((m) => m.publicKey) });
  const usdcOf = async (owner: anchor.web3.PublicKey) =>
    Buffer.from((await h.context.banksClient.getAccount(ataAddress(MINTS.usdc, owner, SPL_TOKEN)))!.data).readBigUInt64LE(64);
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  type Formed = { status: object; joinedBitmap: number; creator: anchor.web3.PublicKey; priceFeed: anchor.web3.PublicKey };
  const circleOf = (circle: anchor.web3.PublicKey) => fetchAccount<Formed>(h.program, "circle", circle);
  const raw = async (k: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(k);
    return info ? Buffer.from(info.data) : null;
  };
  // the view the app decodes from the same accounts (lib/live.ts decodeLive)
  const viewOf = async (circle: anchor.web3.PublicKey) => {
    const c = await circleOf(circle);
    return decodeLive(
      {
        circle: (await raw(circle))!,
        feed: (await raw(c.priceFeed))!,
        mint: (await raw(MINTS.stock))!,
        members: await Promise.all(members.map((m) => raw(memberAddress(h.program.programId, circle, m.publicKey)))),
      },
      "NFLXx mirror",
      Number((await h.context.banksClient.getClock()).unixTimestamp),
    );
  };
  const stockOf = async (w: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(ataAddress(MINTS.stock, w, TOKEN_2022));
    return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
  };
  type Mem = { stockRaw: anchor.BN };
  const memberOf = (circle: anchor.web3.PublicKey, w: anchor.web3.Keypair) =>
    fetchAccount<Mem>(h.program, "member", memberAddress(h.program.programId, circle, w.publicKey));

  it("join with the app's least stock succeeds, and one raw unit less is CollateralBelowMinimum", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2]);
    const view = await viewOf(circle);
    const least = minJoinStock(view);
    assert.ok(least !== null && least > 0n, `the demo circle needs some stock to join: ${least}`);
    assert.ok(countedOfRaw(view, least) >= BigInt(view.minStockCover));
    assert.ok(countedOfRaw(view, least - 1n) < BigInt(view.minStockCover));

    const short = await refusal(sendAs(await joinAndLockIx(members[3]!.publicKey, keys(circle), least - 1n), members[3]!));
    assert.ok(short, "joined with less than the minimum cover");
    assert.match(explainFailure(short), /^CollateralBelowMinimum/);

    // the SOL the page tells the joiner the join costs (lib/solana-join.ts joinLamports) is exactly what it spends
    const solBefore = (await h.context.banksClient.getAccount(members[3]!.publicKey))!.lamports;
    const rentOf = await h.context.banksClient.getRent();
    const missing = {
      usdcAccount: (await raw(ataAddress(MINTS.usdc, members[3]!.publicKey, SPL_TOKEN))) === null,
      stockVault: (await raw(ataAddress(MINTS.stock, circle, TOKEN_2022))) === null,
      usdcVault: (await raw(ataAddress(MINTS.usdc, circle, SPL_TOKEN))) === null,
    };
    await sendAs(await joinAndLockIx(members[3]!.publicKey, keys(circle), least), members[3]!);
    const spent = BigInt(solBefore) - BigInt((await h.context.banksClient.getAccount(members[3]!.publicKey))!.lamports);
    assert.equal(spent, joinLamports(missing, (space) => rentOf.minimumBalance(BigInt(space))), `the join spent ${spent} lamports`);
    assert.equal(BigInt((await memberOf(circle, members[3]!)).stockRaw.toString()), least);
    assert.equal((await circleOf(circle)).joinedBitmap, 0b01111);
  });

  it("a wallet with no seat cannot join, even holding the stock and the guarantee", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2]);
    const stranger = h.fund();
    const stockAta = ataAddress(MINTS.stock, stranger.publicKey, TOKEN_2022);
    const usdcAta = ataAddress(MINTS.usdc, stranger.publicKey, SPL_TOKEN);
    await chain.send([
      createAtaIdempotentIx(h.authority.publicKey, stranger.publicKey, MINTS.stock, TOKEN_2022),
      createAtaIdempotentIx(h.authority.publicKey, stranger.publicKey, MINTS.usdc, SPL_TOKEN),
      mintToCheckedIx(MINTS.stock, stockAta, h.authority.publicKey, BigInt(DEMO.lockRaw), NFLXX_MIRROR_DECIMALS, TOKEN_2022),
      mintToCheckedIx(MINTS.usdc, usdcAta, h.authority.publicKey, BigInt(DEMO.guaranteePerMember), TEST_USDC_DECIMALS, SPL_TOKEN),
    ], [h.authority]);
    const e = await refusal(sendAs(await joinAndLockIx(stranger.publicKey, keys(circle), BigInt(DEMO.lockRaw)), stranger));
    assert.ok(e, "a stranger joined");
    assert.match(explainFailure(e), /^NotAMember/);
  });

  it("a wallet with no stock account is refused before anything moves (AccountNotInitialized): the page checks it first", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2]);
    const stranger = h.fund();
    assert.equal(await raw(ataAddress(MINTS.stock, stranger.publicKey, TOKEN_2022)), null, "precondition: no stock account");
    const e = await refusal(sendAs(await joinAndLockIx(stranger.publicKey, keys(circle), BigInt(DEMO.lockRaw)), stranger));
    assert.ok(e);
    assert.match(explainFailure(e), /AccountNotInitialized|0xbc4/, "Anchor's AccountNotInitialized (3012)");
  });

  it("leave_forming gives the seat back its stock and guarantee and frees the seat", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2]);
    const w = members[1]!;
    const locked = BigInt((await memberOf(circle, w)).stockRaw.toString());
    const [stock0, usdc0] = [await stockOf(w.publicKey), await usdcOf(w.publicKey)];
    await sendAs(await leaveFormingIx(w.publicKey, keys(circle)), w);
    assert.equal((await stockOf(w.publicKey)) - stock0, locked);
    assert.equal((await usdcOf(w.publicKey)) - usdc0, BigInt(DEMO.guaranteePerMember));
    assert.equal((await circleOf(circle)).joinedBitmap, 0b00101);
    assert.equal(await raw(memberAddress(h.program.programId, circle, w.publicKey)), null, "the Member account is closed");
  });

  it("start is refused until every seat has joined, then the creator starts the circle", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2]);
    const early = await refusal(sendAs(await activateIx(members[0]!.publicKey, keys(circle)), members[0]!));
    assert.ok(early, "started with seats empty");
    assert.match(explainFailure(early), /^NotAllJoined/);
    for (const i of [3, 4]) await sendAs(await joinAndLockIx(members[i]!.publicKey, keys(circle), DEMO.lockRaw), members[i]!);
    await sendAs(await activateIx(members[0]!.publicKey, keys(circle)), members[0]!);
    assert.ok("active" in (await circleOf(circle)).status);
  });

  it("only the creator can start or cancel", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2, 3, 4]);
    for (const build of [activateIx, cancelCircleIx]) {
      const e = await refusal(sendAs(await build(members[1]!.publicKey, keys(circle)), members[1]!));
      assert.ok(e, `${build.name} from a member who is not the creator went through`);
      assert.match(explainFailure(e), /^Unauthorized/, build.name);
    }
    assert.ok("forming" in (await circleOf(circle)).status);
  });

  it("cancel, then each joined seat withdraws its stock and guarantee", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2]);
    await sendAs(await cancelCircleIx(members[0]!.publicKey, keys(circle)), members[0]!);
    assert.ok("cancelled" in (await circleOf(circle)).status);
    for (const i of [0, 1, 2]) {
      const w = members[i]!;
      const locked = BigInt((await memberOf(circle, w)).stockRaw.toString());
      const [stock0, usdc0] = [await stockOf(w.publicKey), await usdcOf(w.publicKey)];
      await sendAs(await withdrawIx(w.publicKey, keys(circle)), w);
      assert.equal((await stockOf(w.publicKey)) - stock0, locked);
      assert.equal((await usdcOf(w.publicKey)) - usdc0, BigInt(DEMO.guaranteePerMember));
    }
  });
});
