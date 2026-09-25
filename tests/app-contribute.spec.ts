/**
 * T18: the app's Contribute, sent to the DEVNET build in bankrun after the real
 * demo seed (ops/demo.ts), exactly as the member's wallet will send it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, fetchAccount, harness, type Harness } from "./harness.ts";
import { DEMO, seedDemoCircle, type Chain } from "../ops/demo.ts";
import { NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_SPACE, ataAddress, createDevnetMintsIxs, devnetMintAddresses } from "../ops/devnet-mints.ts";
import { contributeIx, explainFailure } from "../app/src/lib/contribute.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

describe("T18 the app's Contribute, on the devnet build", () => {
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
  const usdcOf = async (owner: anchor.web3.PublicKey) =>
    Buffer.from((await h.context.banksClient.getAccount(ataAddress(MINTS.usdc, owner, SPL_TOKEN)))!.data).readBigUInt64LE(64);

  it("pays exactly one contribution from seat 2 and sets only seat 2's bit", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    const payer = members[1]!;
    const before = await usdcOf(payer.publicKey);

    await sendAs(await contributeIx(payer.publicKey, circle, MINTS.usdc), payer);

    assert.equal(before - (await usdcOf(payer.publicKey)), BigInt(DEMO.contribution));
    const c = await fetchAccount<{ paidBitmap: number; heldContributions: anchor.BN }>(h.program, "circle", circle);
    assert.equal(c.paidBitmap, 0b00010);
    assert.equal(c.heldContributions.toNumber(), DEMO.contribution);
  });

  it("names the program's refusal: a second payment is AlreadyContributed", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    const payer = members[1]!;
    await sendAs(await contributeIx(payer.publicKey, circle, MINTS.usdc), payer);
    const again = await sendAs(await contributeIx(payer.publicKey, circle, MINTS.usdc), payer).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(again, "the second payment went through");
    assert.match(explainFailure(again), /^AlreadyContributed/);
  });

  it("is refused for a wallet that is not in the circle", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    const stranger = h.fund();
    await assert.rejects(sendAs(await contributeIx(stranger.publicKey, circle, MINTS.usdc), stranger));
  });
});
