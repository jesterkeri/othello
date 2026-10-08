/**
 * Adversary, PR #30: the try seed's brief says a re-run of a finished seed sends nothing, "including after the
 * wallet has joined (and after it left)". This joins and leaves through the app's own builders, then re-runs
 * seedTryCircle. Setup below is copied verbatim from tests/b2-devnet-try.spec.ts.
 *
 * PR #29's devnet try, proven on the DEVNET build before Joshua spends SOL: ops/touch-prices.ts and
 * ops/seed-try-circle.ts call touchPrices and seedTryCircle (ops/demo.ts) with a devnet Chain; this spec calls the
 * same functions with a bankrun Chain, on target/devnet/othello.so, with real mint bytes at the devnet addresses.
 *
 * What it shows: the demo price is refreshed without changing a price or its multiplier; the try circle is left
 * Forming with seats 1 to 4 joined and the wallet's seat open and funded; the wallet can then join (through the app's
 * own builder, readiness and least stock), leave, and join again; and neither script changes the demo circle, its feed
 * prices or its pool. Every refusal sends nothing.
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
  TRY_PRICE_MARGIN_SECS,
  addresses,
  seedDemoCircle,
  seedTryCircle,
  touchPrices,
  type Chain,
} from "../ops/demo.ts";
import { NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_SPACE, TOKEN_2022, ataAddress, createDevnetMintsIxs, devnetMintAddresses } from "../ops/devnet-mints.ts";
import { joinAndLockIx, leaveFormingIx, type CircleKeys } from "../app/src/lib/actions.ts";
import { minJoinStock } from "../app/src/lib/circle.ts";
import { joinLamports, joinReadiness } from "../app/src/lib/solana-join.ts";
import { decodeLive, memberAddress } from "../app/src/lib/live.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

type Feed = { wrapperPrice: anchor.BN; sharePrice: anchor.BN; pricedForMultiplier: anchor.BN; updatedAt: anchor.BN };
type CircleState = { status: Record<string, unknown>; n: number; members: anchor.web3.PublicKey[] };

describe("adversary: the try seed re-run after the wallet joined and left", () => {
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
    // The demo as devnet has it: seeded to Active, with its feed and pool.
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
  const demo = () => addresses(h.program, MINTS, demoMembers[0]!.publicKey);
  // The demo's state that neither script may change: its circle, its feed's prices and stamp, its pool.
  const demoState = async () => {
    const a = demo();
    const f = await fetchAccount<Feed>(h.program, "priceFeed", a.feed);
    return {
      circle: (await raw(a.circle))!.toString("hex"),
      prices: [f.wrapperPrice, f.sharePrice, f.pricedForMultiplier].map(String),
      pool: (await raw(a.pool))!.toString("hex"),
      poolUsdc: await tokens(MINTS.usdc, a.pool, SPL_TOKEN),
    };
  };
  const updatedAt = async () => Number((await fetchAccount<Feed>(h.program, "priceFeed", demo().feed)).updatedAt.toString());
  const sendAs = async (ix: anchor.web3.TransactionInstruction, signer: anchor.web3.Keypair) => {
    await h.nextSlot();
    const t = new anchor.web3.Transaction().add(ix);
    t.recentBlockhash = h.context.lastBlockhash;
    t.feePayer = signer.publicKey;
    t.sign(signer);
    await h.context.banksClient.processTransaction(t);
  };

  it("a re-run after the wallet joined and then left sends nothing", async () => {
    const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
    const n = sent;
    const c = await fetchAccount<CircleState>(h.program, "circle", circle);
    const keys: CircleKeys = { circle, usdcMint: MINTS.usdc, stockMint: MINTS.stock, members: c.members.slice(0, c.n) };
    await sendAs(await joinAndLockIx(wallet.publicKey, keys, MEMBER_STOCK), wallet);
    await sendAs(await leaveFormingIx(wallet.publicKey, keys), wallet);
    assert.equal(await raw(memberAddress(h.program.programId, circle, wallet.publicKey)), null, "the leave did not close the seat");
    const walletLamports = await lamportsOf(wallet.publicKey);
    const adminBefore = await lamportsOf(h.authority.publicKey);
    await seedTryCircle(chain, MINTS, scripted, wallet.publicKey);
    const adminAfter = await lamportsOf(h.authority.publicKey);
    assert.equal(
      sent,
      n,
      `a re-run after the wallet left sent ${sent - n} transaction(s); the wallet held ${walletLamports} lamports (MEMBER_LAMPORTS ${MEMBER_LAMPORTS}); the admin spent ${adminBefore - adminAfter}`,
    );
  });
});
