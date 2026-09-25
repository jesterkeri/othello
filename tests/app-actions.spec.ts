/**
 * T18d: the three instructions anyone may send (SPEC §5), as the app builds them
 * (app/src/lib/actions.ts), sent from a stranger's wallet to the DEVNET build in bankrun after
 * the real demo seed (ops/demo.ts).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, fetchAccount, harness, type Harness } from "./harness.ts";
import { DEMO, payRound, seedDemoCircle, type Chain } from "../ops/demo.ts";
import { NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_SPACE, ataAddress, createDevnetMintsIxs, devnetMintAddresses } from "../ops/devnet-mints.ts";
import { explainFailure } from "../app/src/lib/contribute.ts";
import { declareDefaultIx, releasePotIx, updateCoverageIx, type CircleKeys } from "../app/src/lib/actions.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

describe("T18d the app's anyone-may-send actions, on the devnet build", () => {
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

  it("release_pot from a stranger's wallet pays the whole pot to seat 1 and opens round 2", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    await payRound(chain, MINTS, members);
    const stranger = h.fund();
    const before = await usdcOf(members[0]!.publicKey);

    await sendAs(await releasePotIx(stranger.publicKey, keys(circle), members[0]!.publicKey), stranger);

    assert.equal((await usdcOf(members[0]!.publicKey)) - before, BigInt(DEMO.contribution * DEMO.n));
    const c = await read(circle);
    assert.equal(c.round, 1);
    assert.equal(c.receivedBitmap, 0b00001);
    assert.equal(c.paidBitmap, 0);
  });

  it("release_pot before everyone has paid is refused, and the reason is named", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    await payRound(chain, MINTS, members, [3]);
    const stranger = h.fund();
    const e = await refusal(sendAs(await releasePotIx(stranger.publicKey, keys(circle), members[0]!.publicKey), stranger));
    assert.ok(e, "an unfunded round was released");
    assert.match(explainFailure(e), /^RoundNotFunded/);
  });

  it("update_coverage from a stranger's wallet stamps last_coverage_at", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    assert.equal((await read(circle)).lastCoverageAt.toNumber(), 0);
    const stranger = h.fund();
    await sendAs(await updateCoverageIx(stranger.publicKey, keys(circle)), stranger);
    assert.equal((await read(circle)).lastCoverageAt.toNumber(), Number((await h.context.banksClient.getClock()).unixTimestamp));
  });

  it("declare_default from a stranger's wallet, after grace, defaults seat 1 once it has taken the pot and stopped paying", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    await payRound(chain, MINTS, members);
    const stranger = h.fund();
    await sendAs(await releasePotIx(stranger.publicKey, keys(circle), members[0]!.publicKey), stranger);
    await payRound(chain, MINTS, members, [0]);

    const c = await read(circle);
    const graceEnd = c.roundDeadline.toNumber() + c.graceSecs.toNumber();
    await h.setClock(graceEnd);
    const early = await refusal(sendAs(await declareDefaultIx(stranger.publicKey, keys(circle), 0), stranger));
    assert.ok(early, "declared at exactly deadline + grace");
    assert.match(explainFailure(early), /^GraceNotElapsed/);

    await h.setClock(graceEnd + 1);
    await sendAs(await declareDefaultIx(stranger.publicKey, keys(circle), 0), stranger);
    assert.equal((await read(circle)).defaultedBitmap, 0b00001);
  });

  it("declare_default on a seat that has not taken the pot is refused", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    await payRound(chain, MINTS, members, [2]);
    const c = await read(circle);
    await h.setClock(c.roundDeadline.toNumber() + c.graceSecs.toNumber() + 1);
    const stranger = h.fund();
    const e = await refusal(sendAs(await declareDefaultIx(stranger.publicKey, keys(circle), 2), stranger));
    assert.ok(e, "a seat that took nothing was declared in default");
    assert.match(explainFailure(e), /^PrePayoutDefaultUnsupported/);
  });
});
