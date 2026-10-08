/**
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
  memoryTryRecord,
  type TrySeatsRecord,
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

describe("PR #29 devnet try: touch-prices and the try circle, on the devnet build", () => {
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

  let record: TrySeatsRecord;

  beforeEach(async () => {
    record = memoryTryRecord();
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

  it("touch-prices moves only the feed's updated_at, to the chain's now; the demo is otherwise untouched", async () => {
    const before = await demoState();
    const was = await updatedAt();
    await h.setClock(BEFORE_SPLIT + 7 * 86_400);
    const { before: b, after } = await touchPrices(chain, MINTS);
    assert.equal(b, was);
    assert.equal(after, await chain.now());
    assert.equal(await updatedAt(), after);
    assert.deepEqual(await demoState(), before);
    assert.equal(sent, 1);
  });

  it("touch-prices refuses, sending nothing, from a wallet that is not the feed's admin", async () => {
    const other = anchor.web3.Keypair.generate();
    h.fund(anchor.web3.LAMPORTS_PER_SOL, other);
    await assert.rejects(touchPrices({ ...chain, admin: other }, MINTS), /belongs to .* not this admin\. Nothing was sent/);
    assert.equal(sent, 0);
  });

  it("the try circle: Forming, seats 1 to 4 joined, the wallet's seat open and funded; the wallet joins, leaves and joins again", async () => {
    const before = await demoState();
    const adminBefore = await lamportsOf(h.authority.publicKey);
    const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record);
    const spent = adminBefore - (await lamportsOf(h.authority.publicKey));
    // What the try costs the admin, so devnet funding is a measured figure.
    console.log(`      try circle cost to admin: ${(Number(spent) / anchor.web3.LAMPORTS_PER_SOL).toFixed(6)} SOL in ${sent} transactions`);
    assert.ok(spent < BigInt(0.2 * anchor.web3.LAMPORTS_PER_SOL), `the try circle cost ${spent} lamports`);
    const c = await fetchAccount<CircleState>(h.program, "circle", circle);
    assert.ok("forming" in c.status, `circle is ${JSON.stringify(c.status)}`);
    assert.deepEqual(c.members.slice(0, c.n).map(String), [...scripted, wallet].map((k) => k.publicKey.toBase58()));
    for (const k of scripted) assert.ok(await raw(memberAddress(h.program.programId, circle, k.publicKey)), "a script seat is not joined");
    assert.equal(await raw(memberAddress(h.program.programId, circle, wallet.publicKey)), null, "the wallet's seat must be left open");
    assert.equal(await lamportsOf(wallet.publicKey), BigInt(MEMBER_LAMPORTS));
    assert.equal(await tokens(MINTS.stock, wallet.publicKey, TOKEN_2022), MEMBER_STOCK);
    assert.equal(await tokens(MINTS.usdc, wallet.publicKey, SPL_TOKEN), MEMBER_USDC);
    assert.deepEqual(await demoState(), before, "the try circle changed the demo");

    // The app's own view, least stock, readiness and builder, as SolanaJoin uses them.
    const feed = (await fetchAccount<{ priceFeed: anchor.web3.PublicKey }>(h.program, "circle", circle)).priceFeed;
    const view = async () =>
      decodeLive(
        {
          circle: (await raw(circle))!,
          feed: (await raw(feed))!,
          mint: (await raw(MINTS.stock))!,
          members: await Promise.all(c.members.slice(0, c.n).map((m) => raw(memberAddress(h.program.programId, circle, m)))),
        },
        "NFLXx mirror",
        await chain.now(),
      );
    const keys: CircleKeys = { circle, usdcMint: MINTS.usdc, stockMint: MINTS.stock, members: c.members.slice(0, c.n) };
    const rentOf = await h.context.banksClient.getRent();
    const ready = async () => {
      const v = await view();
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
      return { least, r: joinReadiness(v, least, balances, null, { stock: "NFLXx devnet mirror", usdc: (b) => `${b} test USDC` }) };
    };

    const first = await ready();
    assert.ok(first.r.enabled, `the page would not enable the join: ${first.r.reason}`);
    assert.ok(first.least <= MEMBER_STOCK, `the least join (${first.least}) is more than the wallet is given`);
    await sendAs(await joinAndLockIx(wallet.publicKey, keys, first.least), wallet);
    assert.ok(await raw(memberAddress(h.program.programId, circle, wallet.publicKey)), "the join did not land");
    assert.equal(await tokens(MINTS.stock, wallet.publicKey, TOKEN_2022), MEMBER_STOCK - first.least);

    await sendAs(await leaveFormingIx(wallet.publicKey, keys), wallet);
    assert.equal(await raw(memberAddress(h.program.programId, circle, wallet.publicKey)), null, "the leave did not close the seat");
    assert.equal(await tokens(MINTS.stock, wallet.publicKey, TOKEN_2022), MEMBER_STOCK, "the stock came back");
    assert.equal(await tokens(MINTS.usdc, wallet.publicKey, SPL_TOKEN), MEMBER_USDC, "the guarantee came back");

    const again = await ready();
    assert.ok(again.r.enabled, `the page would not enable the second join: ${again.r.reason}`);
    await sendAs(await joinAndLockIx(wallet.publicKey, keys, again.least), wallet);
    assert.ok(await raw(memberAddress(h.program.programId, circle, wallet.publicKey)), "the second join did not land");
    assert.ok("forming" in (await fetchAccount<CircleState>(h.program, "circle", circle)).status, "only the creator starts it");
    assert.deepEqual(await demoState(), before, "the try changed the demo");
  });

  it("is safe to re-run: a second run sends nothing, before and after the wallet joins", async () => {
    const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record);
    const n = sent;
    assert.ok((await seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record)).equals(circle));
    assert.equal(sent, n);
    const c = await fetchAccount<CircleState>(h.program, "circle", circle);
    const keys: CircleKeys = { circle, usdcMint: MINTS.usdc, stockMint: MINTS.stock, members: c.members.slice(0, c.n) };
    await sendAs(await joinAndLockIx(wallet.publicKey, keys, MEMBER_STOCK), wallet);
    await seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record);
    assert.equal(sent, n, "a re-run after the join sent more");
  });

  it("refuses, sending nothing, when the price would go stale within the margin; touch-prices then lets it through", async () => {
    await h.setClock((await updatedAt()) + DEMO.maxPriceAge - TRY_PRICE_MARGIN_SECS + 1);
    await assert.rejects(seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record), /run ops\/touch-prices\.ts first\. Nothing was sent/);
    assert.equal(sent, 0);
    await touchPrices(chain, MINTS);
    const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record);
    assert.ok("forming" in (await fetchAccount<CircleState>(h.program, "circle", circle)).status);
  });

  it("refuses, sending nothing: another wallet for an existing try circle, the admin or a script key as the wallet, an address that cannot sign", async () => {
    await seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record);
    const n = sent;
    await assert.rejects(seedTryCircle(chain, MINTS, scripted, anchor.web3.Keypair.generate().publicKey, record), /seats are not these keys and this wallet\. Nothing was sent/);
    await assert.rejects(seedTryCircle(chain, MINTS, scripted, h.authority.publicKey, record), /the admin or a script-held key/);
    await assert.rejects(seedTryCircle(chain, MINTS, scripted, scripted[2]!.publicKey, record), /the admin or a script-held key/);
    await assert.rejects(seedTryCircle(chain, MINTS, scripted, demo().circle, record), /is not a wallet address/);
    assert.equal(sent, n);
  });

  it("PR #30 Codex r1: a run stopped after funding wallet A binds the rerun to A; wallet B is refused, unfunded, and no circle is made", async () => {
    // Stop the first run (wallet A) after its first send lands: A's seat may be funded, no circle exists yet.
    const send = chain.send;
    let n = 0;
    const stopping: Chain = { ...chain, send: async (ixs, signers) => { if (n++ >= 5) throw new Error("stopped"); await send(ixs, signers); } };
    await assert.rejects(seedTryCircle(stopping, MINTS, scripted, wallet.publicKey, record), /stopped/);
    const tryCircle = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("circle"), scripted[0]!.publicKey.toBuffer(), Buffer.alloc(8)],
      h.program.programId,
    )[0];
    assert.equal(await raw(tryCircle), null, "the stopped run must not have created the circle");
    assert.ok(await lamportsOf(wallet.publicKey) > 0n, "not vacuous: wallet A was funded before the stop");
    assert.deepEqual(record.read(), [...scripted, wallet].map((k) => k.publicKey.toBase58()), "the seats were recorded before the first send");

    const other = anchor.web3.Keypair.generate();
    const before = sent;
    await assert.rejects(seedTryCircle(chain, MINTS, scripted, other.publicKey, record), /is recorded for wallet .*Nothing was sent/);
    assert.equal(sent, before, "the rerun with wallet B sent something");
    assert.equal(await lamportsOf(other.publicKey), 0n, "wallet B was funded");
    assert.equal(await tokens(MINTS.stock, other.publicKey, TOKEN_2022), 0n);
    assert.equal(await raw(tryCircle), null, "a circle was created for wallet B");

    // The same wallet finishes it.
    const circle = await seedTryCircle(chain, MINTS, scripted, wallet.publicKey, record);
    assert.ok(circle.equals(tryCircle));
    assert.ok("forming" in (await fetchAccount<CircleState>(h.program, "circle", circle)).status);
  });

  it("refuses, sending nothing, when the demo's pool or feed is missing (it never creates them)", async () => {
    const otherStock = { ...MINTS, usdc: anchor.web3.Keypair.generate().publicKey };
    await assert.rejects(seedTryCircle(chain, otherStock, scripted, wallet.publicKey, record), /pool .* is missing or not this admin's: seed the demo circle first\. Nothing was sent/);
    assert.equal(sent, 0);
  });
});
