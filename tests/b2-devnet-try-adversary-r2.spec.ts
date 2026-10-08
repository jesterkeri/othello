/**
 * Adversary, PR #30 (52e99a1): attacks on seedTryCircle and touchPrices (ops/demo.ts) that tests/b2-devnet-try.spec.ts
 * does not run. Setup copied from tests/b2-devnet-try.spec.ts (devnet build, real mint bytes at the devnet addresses).
 *
 * 1. A run stopped at every send, both before the send lands and after it lands with the answer lost, is finished by a
 *    re-run; the wallet can then join at the app's least stock, leave and join again; a further re-run sends nothing.
 * 2. A wallet that already holds part of what a seat needs is topped up to exactly the seat's amounts, never past.
 * 3. After the demo's 10x split is in force (the devnet demo's planned state), the try circle still seeds and the
 *    wallet can join, leave and join again through the app's readiness and builders.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, harness, type Harness, fetchAccount } from "./harness.ts";
import {
  DEMO,
  MEMBER_LAMPORTS,
  MEMBER_STOCK,
  MEMBER_USDC,
  addresses,
  scheduleSplit,
  seedDemoCircle,
  seedTryCircle,
  touchPrices,
  type Chain,
} from "../ops/demo.ts";
import {
  NFLXX_MIRROR_DECIMALS,
  NFLXX_MIRROR_SPACE,
  SPL_TOKEN,
  TEST_USDC_DECIMALS,
  TEST_USDC_SPACE,
  TOKEN_2022,
  ataAddress,
  createAtaIdempotentIx,
  createDevnetMintsIxs,
  devnetMintAddresses,
  mintToCheckedIx,
} from "../ops/devnet-mints.ts";
import { joinAndLockIx, leaveFormingIx, type CircleKeys } from "../app/src/lib/actions.ts";
import { minJoinStock } from "../app/src/lib/circle.ts";
import { joinLamports, joinReadiness } from "../app/src/lib/solana-join.ts";
import { decodeLive, memberAddress } from "../app/src/lib/live.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

type CircleState = { status: Record<string, unknown>; n: number; members: anchor.web3.PublicKey[] };

describe("adversary r2: the try seed, stopped at every send, a part-funded wallet, and after the split", () => {
  let h: Harness;
  let chain: Chain;
  let sent: number;
  let demoMembers: anchor.web3.Keypair[];
  let scripted: anchor.web3.Keypair[];
  let wallet: anchor.web3.Keypair;

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
    demoMembers = Array.from({ length: DEMO.n }, () => anchor.web3.Keypair.generate());
    await seedDemoCircle(chain, MINTS, demoMembers);
    scripted = Array.from({ length: DEMO.n - 1 }, () => anchor.web3.Keypair.generate());
    wallet = anchor.web3.Keypair.generate();
    sent = 0;
  });

  const raw = async (k: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(k);
    return info ? Buffer.from(info.data) : null;
  };
  const tokens = async (mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, program: anchor.web3.PublicKey) => {
    const d = await raw(ataAddress(mint, owner, program));
    return d ? d.readBigUInt64LE(64) : 0n;
  };
  const lamportsOf = async (k: anchor.web3.PublicKey) => BigInt((await h.context.banksClient.getAccount(k))?.lamports ?? 0);
  const sendAs = async (ix: anchor.web3.TransactionInstruction, signer: anchor.web3.Keypair) => {
    await h.nextSlot();
    const t = new anchor.web3.Transaction().add(ix);
    t.recentBlockhash = h.context.lastBlockhash;
    t.feePayer = signer.publicKey;
    t.sign(signer);
    await h.context.banksClient.processTransaction(t);
  };
  /** A chain whose send number `k` (0-based) stops the run: before it lands, or after it lands with the answer lost. */
  const stopping = (k: number, landed: boolean): Chain => {
    let i = 0;
    return {
      ...chain,
      send: async (ixs, signers) => {
        if (i++ === k) {
          if (landed) await chain.send(ixs, signers);
          throw new Error(`stopped at send ${k}`);
        }
        await chain.send(ixs, signers);
      },
    };
  };
  /** The app's readiness for the wallet, as SolanaJoin uses it. */
  const ready = async (circle: anchor.web3.PublicKey) => {
    const c = await fetchAccount<CircleState>(h.program, "circle", circle);
    const feed = (await fetchAccount<{ priceFeed: anchor.web3.PublicKey }>(h.program, "circle", circle)).priceFeed;
    const v = decodeLive(
      {
        circle: (await raw(circle))!,
        feed: (await raw(feed))!,
        mint: (await raw(MINTS.stock))!,
        members: await Promise.all(c.members.slice(0, c.n).map((m) => raw(memberAddress(h.program.programId, circle, m)))),
      },
      "NFLXx mirror",
      await chain.now(),
    );
    const rentOf = await h.context.banksClient.getRent();
    const least = minJoinStock(v)!;
    const solNeeded = joinLamports(
      {
        usdcAccount: (await raw(ataAddress(MINTS.usdc, wallet.publicKey, SPL_TOKEN))) === null,
        stockVault: (await raw(ataAddress(MINTS.stock, circle, TOKEN_2022))) === null,
        usdcVault: (await raw(ataAddress(MINTS.usdc, circle, SPL_TOKEN))) === null,
      },
      (space) => rentOf.minimumBalance(BigInt(space)),
    );
    const balances = {
      stock: await tokens(MINTS.stock, wallet.publicKey, TOKEN_2022),
      usdc: await tokens(MINTS.usdc, wallet.publicKey, SPL_TOKEN),
      sol: await lamportsOf(wallet.publicKey),
      solNeeded,
      solKeep: rentOf.minimumBalance(0n),
    };
    const keys: CircleKeys = { circle, usdcMint: MINTS.usdc, stockMint: MINTS.stock, members: c.members.slice(0, c.n) };
    return { least, keys, r: joinReadiness(v, least, balances, null, { stock: "NFLXx devnet mirror", usdc: (b) => `${b} test USDC` }) };
  };
  const finishedState = async (circle: anchor.web3.PublicKey) => {
    const c = await fetchAccount<CircleState>(h.program, "circle", circle);
    assert.ok("forming" in c.status, `circle is ${JSON.stringify(c.status)}`);
    assert.deepEqual(c.members.slice(0, c.n).map(String), [...scripted, wallet].map((k) => k.publicKey.toBase58()));
    for (const k of scripted) assert.ok(await raw(memberAddress(h.program.programId, circle, k.publicKey)), "a script seat is not joined");
    assert.equal(await raw(memberAddress(h.program.programId, circle, wallet.publicKey)), null);
  };
  const joinLeaveJoin = async (circle: anchor.web3.PublicKey, label: string) => {
    const first = await ready(circle);
    assert.ok(first.r.enabled, `${label}: the page would not enable the join: ${first.r.reason}`);
    assert.ok(first.least <= MEMBER_STOCK, `${label}: least ${first.least}`);
    await sendAs(await joinAndLockIx(wallet.publicKey, first.keys, first.least), wallet);
    await sendAs(await leaveFormingIx(wallet.publicKey, first.keys), wallet);
    const again = await ready(circle);
    assert.ok(again.r.enabled, `${label}: the page would not enable the second join: ${again.r.reason}`);
    await sendAs(await joinAndLockIx(wallet.publicKey, again.keys, again.least), wallet);
    assert.ok(await raw(memberAddress(h.program.programId, circle, wallet.publicKey)), `${label}: the second join did not land`);
  };

  for (const landed of [false, true]) {
    it(`a run stopped at any send (${landed ? "after it landed" : "before it landed"}) is finished by a re-run; the wallet joins; later re-runs send nothing`, async () => {
      // A clean run sends 10 transactions (tests/b2-devnet-try.spec.ts logs it): funding x5, create, joins x4.
      for (let k = 0; k < 10; k++) {
        scripted = Array.from({ length: DEMO.n - 1 }, () => anchor.web3.Keypair.generate());
        wallet = anchor.web3.Keypair.generate();
        await assert.rejects(seedTryCircle(stopping(k, landed), MINTS, scripted, wallet.publicKey), /stopped at send/);
        const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
        await finishedState(circle);
        assert.equal(await tokens(MINTS.stock, wallet.publicKey, TOKEN_2022), MEMBER_STOCK, `stop ${k}: wallet stock`);
        assert.equal(await tokens(MINTS.usdc, wallet.publicKey, SPL_TOKEN), MEMBER_USDC, `stop ${k}: wallet usdc`);
        assert.equal(await lamportsOf(wallet.publicKey), BigInt(MEMBER_LAMPORTS), `stop ${k}: wallet SOL`);
        const n = sent;
        await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
        assert.equal(sent, n, `stop ${k}: a re-run of the finished seed sent more`);
        await joinLeaveJoin(circle, `stop ${k}`);
        await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
        assert.equal(sent, n, `stop ${k}: a re-run after join, leave, join sent more`);
      }
    });
  }

  it("a run stopped after the circle exists, then the wallet joins and leaves, is finished by a re-run that funds nobody", async () => {
    // Sends 0-4 fund, 5 creates, 6-9 join seats 1-4. Stop before seat 2 joins (send 7).
    for (const k of [6, 7, 9]) {
      scripted = Array.from({ length: DEMO.n - 1 }, () => anchor.web3.Keypair.generate());
      wallet = anchor.web3.Keypair.generate();
      await assert.rejects(seedTryCircle(stopping(k, false), MINTS, scripted, wallet.publicKey), /stopped at send/);
      const circle = addresses(h.program, MINTS, scripted[0]!.publicKey).circle;
      const early = await ready(circle);
      await sendAs(await joinAndLockIx(wallet.publicKey, early.keys, early.least), wallet);
      await sendAs(await leaveFormingIx(wallet.publicKey, early.keys), wallet);
      const adminBefore = await lamportsOf(h.authority.publicKey);
      const walletBefore = await lamportsOf(wallet.publicKey);
      await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
      assert.equal(await lamportsOf(h.authority.publicKey), adminBefore, `stop ${k}: the admin paid for the re-run`);
      assert.equal(await lamportsOf(wallet.publicKey), walletBefore, `stop ${k}: the wallet was topped up after the circle existed`);
      await finishedState(circle);
      const n = sent;
      await joinLeaveJoin(circle, `stop ${k}, early join`);
      await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
      assert.equal(sent, n, `stop ${k}: a re-run after join, leave, join sent more`);
    }
  });

  it("a wallet holding part of a seat's needs is topped up to exactly the seat's amounts, and can join", async () => {
    // 0.5 token, 100 test USDC and 0.005 SOL before the seed.
    await chain.send(
      [
        createAtaIdempotentIx(h.authority.publicKey, wallet.publicKey, MINTS.stock, TOKEN_2022),
        mintToCheckedIx(MINTS.stock, ataAddress(MINTS.stock, wallet.publicKey, TOKEN_2022), h.authority.publicKey, 50_000_000n, NFLXX_MIRROR_DECIMALS, TOKEN_2022),
        createAtaIdempotentIx(h.authority.publicKey, wallet.publicKey, MINTS.usdc, SPL_TOKEN),
        mintToCheckedIx(MINTS.usdc, ataAddress(MINTS.usdc, wallet.publicKey, SPL_TOKEN), h.authority.publicKey, 100_000_000n, TEST_USDC_DECIMALS, SPL_TOKEN),
        anchor.web3.SystemProgram.transfer({ fromPubkey: h.authority.publicKey, toPubkey: wallet.publicKey, lamports: 5_000_000 }),
      ],
      [h.authority],
    );
    const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
    assert.equal(await tokens(MINTS.stock, wallet.publicKey, TOKEN_2022), MEMBER_STOCK);
    assert.equal(await tokens(MINTS.usdc, wallet.publicKey, SPL_TOKEN), MEMBER_USDC);
    assert.equal(await lamportsOf(wallet.publicKey), BigInt(MEMBER_LAMPORTS));
    await joinLeaveJoin(circle, "part-funded");
  });

  it("after the demo's 10x split is in force, the try circle seeds and the wallet joins, leaves and joins again", async () => {
    const now = await chain.now();
    await scheduleSplit(chain, MINTS, demoMembers[0]!.publicKey, now + 600);
    await h.setClock(now + 700);
    await touchPrices(chain, MINTS);
    const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
    await finishedState(circle);
    await joinLeaveJoin(circle, "after the split");
  });
});
