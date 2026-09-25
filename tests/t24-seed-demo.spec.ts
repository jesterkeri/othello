/**
 * T24: the demo seed, run against the DEVNET build before it spends SOL.
 *
 * `ops/seed-demo-circle.ts` and `ops/schedule-split.ts` call the functions in
 * ops/demo.ts with a devnet Chain. This spec calls the same functions with a
 * bankrun Chain, on target/devnet/othello.so, with real Token-2022 mint bytes
 * at the devnet addresses. So what is proven here is what devnet will run.
 *
 * Done-when (TASKS T24): "circle address recorded; all five joined before the
 * split". And SPEC.md:137: after the split's effective time H is unchanged at 132.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, decodeValuation, fetchAccount, harness, quoteIx, send, type Harness } from "./harness.ts";
import {
  DEMO,
  MEMBER_STOCK,
  MEMBER_USDC,
  POOL_SEED_USDC,
  addresses,
  scheduleSplit,
  seedDemoCircle,
  type Chain,
} from "../ops/demo.ts";
import {
  NFLXX_MIRROR_SPACE,
  SPL_TOKEN,
  TEST_USDC_SPACE,
  TOKEN_2022,
  ataAddress,
  createDevnetMintsIxs,
  devnetMintAddresses,
} from "../ops/devnet-mints.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

type CircleState = { status: Record<string, unknown>; n: number; members: anchor.web3.PublicKey[]; contribution: anchor.BN; guaranteePerMember: anchor.BN };
type MemberState = { turn: number; stockRaw: anchor.BN };

describe("T24 demo seed, on the devnet build", () => {
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

  const lamportsOf = async (k: anchor.web3.PublicKey) => Number((await h.context.banksClient.getAccount(k))?.lamports ?? 0);
  const tokens = async (mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, program: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(ataAddress(mint, owner, program));
    return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
  };
  const quoteH = async () => decodeValuation(await send(h, await quoteIx(h, MINTS.stock, { raw: DEMO.lockRaw.toString(), haircutBps: DEMO.haircutBps, maxPriceAge: DEMO.maxPriceAge }))).h;

  it("seeds SPEC's demo circle to Active with all five joined, each locking 1.1 mirror tokens", async () => {
    const adminBefore = await lamportsOf(h.authority.publicKey);
    const circle = await seedDemoCircle(chain, MINTS, members);
    const spent = adminBefore - (await lamportsOf(h.authority.publicKey));

    const c = await fetchAccount<CircleState>(h.program, "circle", circle);
    assert.ok("active" in c.status, `circle is ${JSON.stringify(c.status)}`);
    assert.equal(c.n, DEMO.n);
    assert.equal(c.contribution.toNumber(), DEMO.contribution);
    assert.equal(c.guaranteePerMember.toNumber(), DEMO.guaranteePerMember);
    assert.deepEqual(c.members.slice(0, DEMO.n).map(String), members.map((m) => m.publicKey.toBase58()), "turn order = member order");

    const a = addresses(h.program, MINTS, members[0]!.publicKey);
    for (const [i, m] of members.entries()) {
      const member = await fetchAccount<MemberState>(h.program, "member", a.member(m.publicKey));
      assert.equal(member.turn, i);
      assert.equal(member.stockRaw.toString(), MEMBER_STOCK.toString(), "1.1 token locked");
      // What is left is exactly every round's contribution: the guarantee went in.
      assert.equal(await tokens(MINTS.usdc, m.publicKey, SPL_TOKEN), MEMBER_USDC - BigInt(DEMO.guaranteePerMember));
      assert.equal(await tokens(MINTS.stock, m.publicKey, TOKEN_2022), 0n);
    }
    assert.equal(await tokens(MINTS.usdc, a.pool, SPL_TOKEN), POOL_SEED_USDC);
    assert.equal(await tokens(MINTS.stock, circle, TOKEN_2022), MEMBER_STOCK * BigInt(DEMO.n));

    // SPEC.md:137: EXEC = FUND = 165, H = 132 before the split.
    assert.equal(await quoteH(), 132_000_000n);

    // What the seed costs the admin, so devnet funding is a measured figure.
    console.log(`      seed cost to admin: ${(spent / anchor.web3.LAMPORTS_PER_SOL).toFixed(6)} SOL in ${sent} transactions`);
    assert.ok(spent < 0.3 * anchor.web3.LAMPORTS_PER_SOL, `the seed cost ${spent / anchor.web3.LAMPORTS_PER_SOL} SOL`);
  });

  it("is safe to re-run: a second run sends nothing and changes nothing", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    const before = sent;
    const vault = await tokens(MINTS.stock, circle, TOKEN_2022);

    assert.ok((await seedDemoCircle(chain, MINTS, members)).equals(circle));
    assert.equal(sent, before, "the re-run sent transactions");
    assert.equal(await tokens(MINTS.stock, circle, TOKEN_2022), vault);
  });

  it("finishes a run that stopped half way (after the pool, before any member)", async () => {
    // A crash after step 2: the same code with the member list cut short never
    // gets past its own length check, so stop it by failing the first member send.
    const real = chain.send;
    let calls = 0;
    chain.send = async (ixs, signers) => {
      if (++calls === 4) throw new Error("simulated dropped RPC");
      await real(ixs, signers);
    };
    await assert.rejects(seedDemoCircle(chain, MINTS, members), /simulated dropped RPC/);

    chain.send = real;
    const circle = await seedDemoCircle(chain, MINTS, members);
    const c = await fetchAccount<CircleState>(h.program, "circle", circle);
    assert.ok("active" in c.status);
    assert.equal(await tokens(MINTS.usdc, addresses(h.program, MINTS, members[0]!.publicKey).pool, SPL_TOKEN), POOL_SEED_USDC, "pool not double-seeded");
  });

  it("schedules the split: the circle's H is still 132 once the multiplier is 10", async () => {
    await seedDemoCircle(chain, MINTS, members);
    const now = await chain.now();
    await scheduleSplit(chain, MINTS, now + 120);

    // Repricing: joining now would be refused, which is why every member joined first.
    await h.setClock(now + 121);
    await h.nextSlot();
    assert.equal(await quoteH(), 132_000_000n, "value preserved across the 10-for-1 split");
  });

  it("refuses to schedule a split in the past", async () => {
    await seedDemoCircle(chain, MINTS, members);
    await assert.rejects(scheduleSplit(chain, MINTS, (await chain.now()) - 1), /must be in the future/);
  });
});
