/**
 * T25: the demo video's script, end to end, on the DEVNET build in bankrun.
 * Seed -> round 1 paid by four scripted seats plus seat 2 through the APP's
 * Contribute -> pot released to seat 1 -> split scheduled and effective ->
 * round 2 paid -> pot released to seat 2 (Joshua's seat in Phantom). H stays
 * 132 throughout, which is the claim the video makes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, decodeValuation, fetchAccount, harness, quoteIx, send, type Harness } from "./harness.ts";
import { DEMO, payRound, releasePot, scheduleSplit, seedDemoCircle, type Chain } from "../ops/demo.ts";
import { NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_SPACE, ataAddress, createDevnetMintsIxs, devnetMintAddresses } from "../ops/devnet-mints.ts";
import { contributeIx } from "../app/src/lib/contribute.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };
type CircleState = { round: number; paidBitmap: number; receivedBitmap: number; status: Record<string, unknown> };

describe("T25 the demo script, end to end on the devnet build", () => {
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

  const usdcOf = async (owner: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(ataAddress(MINTS.usdc, owner, SPL_TOKEN));
    return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
  };
  const quoteH = async () =>
    decodeValuation(await send(h, await quoteIx(h, MINTS.stock, { raw: DEMO.lockRaw.toString(), haircutBps: DEMO.haircutBps, maxPriceAge: DEMO.maxPriceAge }))).h;
  const appPays = async (m: anchor.web3.Keypair, circle: anchor.web3.PublicKey) => {
    await h.nextSlot();
    const t = new anchor.web3.Transaction().add(await contributeIx(m.publicKey, circle, MINTS.usdc));
    t.recentBlockhash = h.context.lastBlockhash;
    t.feePayer = m.publicKey;
    t.sign(m);
    await h.context.banksClient.processTransaction(t);
  };

  it("plays two rounds around the split: seat 1 then seat 2 are paid 250, and H is 132 before and after", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    const pot = BigInt(DEMO.contribution * DEMO.n);

    // Round 1: the script pays seats 1, 3, 4, 5; seat 2 pays in the app.
    assert.deepEqual(await payRound(chain, MINTS, members, [1]), [0, 2, 3, 4]);
    await appPays(members[1]!, circle);
    const seat1Before = await usdcOf(members[0]!.publicKey);
    await releasePot(chain, MINTS, members[0]!.publicKey);
    assert.equal((await usdcOf(members[0]!.publicKey)) - seat1Before, pot, "seat 1 received the pot");
    let c = await fetchAccount<CircleState>(h.program, "circle", circle);
    assert.equal(c.round, 1);
    assert.equal(c.receivedBitmap, 0b00001);
    assert.equal(await quoteH(), 132_000_000n);

    // The split, on camera.
    const now = await chain.now();
    await scheduleSplit(chain, MINTS, members[0]!.publicKey, now + 90);
    await h.setClock(now + 91);
    await h.nextSlot();
    assert.equal(await quoteH(), 132_000_000n, "H unchanged after the 10-for-1");

    // Round 2: everyone pays; the pot goes to seat 2.
    assert.deepEqual(await payRound(chain, MINTS, members, [1]), [0, 2, 3, 4]);
    await appPays(members[1]!, circle);
    const seat2Before = await usdcOf(members[1]!.publicKey);
    await releasePot(chain, MINTS, members[0]!.publicKey);
    assert.equal((await usdcOf(members[1]!.publicKey)) - seat2Before, pot, "seat 2 received the pot");
    c = await fetchAccount<CircleState>(h.program, "circle", circle);
    assert.equal(c.round, 2);
    assert.equal(c.receivedBitmap, 0b00011);
  });

  it("refuses to release an unfunded round, naming the seats that have not paid, and sends nothing", async () => {
    await seedDemoCircle(chain, MINTS, members);
    await payRound(chain, MINTS, members, [1, 3]);
    const before = sent;
    await assert.rejects(releasePot(chain, MINTS, members[0]!.publicKey), /seat\(s\) 2, 4 have not paid/);
    assert.equal(sent, before);
  });

  it("pays nobody twice: a second payRound in the same round sends nothing", async () => {
    await seedDemoCircle(chain, MINTS, members);
    await payRound(chain, MINTS, members);
    const before = sent;
    assert.deepEqual(await payRound(chain, MINTS, members), []);
    assert.equal(sent, before);
  });
});
