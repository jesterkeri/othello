/**
 * Adversary r3, PR #30 (3d3e90f): the try seed's binding between the script keys and the wallet. The spec: "once any
 * run has sent anything for wallet A, no run with another wallet B may send anything (no funding for B, no circle
 * for B), whether or not the circle exists yet".
 *
 * At 3d3e90f the keys lived per machine (~/.config/othello-demo/devnet-try/) but the binding per checkout
 * (ops/try-circle.json), so a run from a second checkout (another worktree, or one recreated after `git worktree
 * remove`) found no record, reused the same keys and funded wallet B. Since the fix the binding lives with the keys
 * (devnet-cli.ts TRY_BINDING, written atomically before the first send), and both runs here go through
 * seed-try-circle.ts's own pre-check and keys (tryRunFor), whichever checkout they run from.
 *
 * HOME is pointed at a fresh temp folder while ops/devnet-cli.ts is imported, so TRY_DIR is a throwaway folder and the
 * real ~/.config is never read. Nothing is sent to any cluster: the chain is bankrun on target/devnet/othello.so.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, harness, type Harness } from "./harness.ts";
import { DEMO, seedDemoCircle, seedTryCircle, type TrySeatsRecord, type Chain } from "../ops/demo.ts";
import { NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_SPACE, TOKEN_2022, ataAddress, createDevnetMintsIxs, devnetMintAddresses } from "../ops/devnet-mints.ts";

const DEVNET_SO = "target/devnet/othello.so";
const mintsRecord = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(mintsRecord.nflxxMirror), usdc: new anchor.web3.PublicKey(mintsRecord.testUsdc) };

// ops/seed-try-circle.ts's record object at 3d3e90f, pointed at a given checkout's ops/try-circle.json.
describe("adversary r3: the try seed's wallet binding across two checkouts on one machine", () => {
  let h: Harness;
  let chain: Chain;
  let sent: number;
  let cli: typeof import("../ops/devnet-cli.ts");
  let fakeHome: string;
  let otherCheckout: string;
  let madeHere = false;

  before(async function () {
    this.timeout(600_000);
    const built = spawnSync(
      "cargo",
      ["build-sbf", "--manifest-path", "programs/othello/Cargo.toml", "--features", "devnet", "--sbf-out-dir", "target/devnet"],
      { cwd: REPO, env: { ...process.env, PATH: TOOLCHAIN_PATH }, encoding: "utf8" },
    );
    assert.equal(built.status, 0, `devnet build failed: ${built.stderr || built.error}`);

    fakeHome = mkdtempSync(join(tmpdir(), "othello-try-home-"));
    otherCheckout = mkdtempSync(join(tmpdir(), "othello-try-checkout-"));
    mkdirSync(join(otherCheckout, "ops"));
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      cli = await import("../ops/devnet-cli.ts");
    } finally {
      process.env.HOME = realHome;
    }
    assert.ok(!existsSync(cli.TRY_RECORD), `${cli.TRY_RECORD} exists in this checkout; the spec needs a checkout without one`);
  });

  after(() => {
    if (madeHere && cli && existsSync(cli.TRY_RECORD)) rmSync(cli.TRY_RECORD);
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
    if (otherCheckout) rmSync(otherCheckout, { recursive: true, force: true });
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
    await seedDemoCircle(chain, MINTS, Array.from({ length: DEMO.n }, () => anchor.web3.Keypair.generate()));
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

  it("a run in checkout 1 stopped after funding wallet A; a run in checkout 2 with wallet B must send nothing", async () => {
    const walletA = anchor.web3.Keypair.generate().publicKey;
    const walletB = anchor.web3.Keypair.generate().publicKey;

    // The binding is machine-wide: it lives with the keys under HOME, never in a checkout (which a second checkout
    // would not have). Both runs below would share any one path, so this is what pins the fix.
    assert.ok(cli.TRY_BINDING.startsWith(fakeHome + "/"), `the binding ${cli.TRY_BINDING} is not in the keys' folder under HOME`);
    assert.ok(!cli.TRY_BINDING.startsWith(REPO), "the binding is inside the checkout");

    // Checkout 1: seed-try-circle.ts's own pre-check and keys (tryRunFor), so the keys are made in TRY_DIR.
    const run1 = cli.tryRunFor(walletA, DEMO.n - 1);
    const keys1 = run1.keys;
    const send = chain.send;
    let n = 0;
    const stopping: Chain = { ...chain, send: async (ixs, signers) => { if (n++ >= 5) throw new Error("stopped"); await send(ixs, signers); } };
    await assert.rejects(seedTryCircle(stopping, MINTS, keys1, walletA, run1.binding), /stopped/);
    assert.ok((await lamportsOf(walletA)) > 0n, "not vacuous: wallet A was funded before the stop");
    assert.equal(run1.binding.read()![DEMO.n - 1], walletA.toBase58(), "the binding names wallet A before the stop");
    const tryCircle = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("circle"), keys1[0]!.publicKey.toBuffer(), Buffer.alloc(8)],
      h.program.programId,
    )[0];
    assert.equal(await raw(tryCircle), null, "not vacuous: no circle exists yet");

    // Checkout 2 (this one): seed-try-circle.ts's own steps, in order, with wallet B.
    madeHere = !existsSync(cli.TRY_RECORD);
    const before = sent;
    await assert.rejects(
      (async () => {
        const run2 = cli.tryRunFor(walletB, DEMO.n - 1);
        return seedTryCircle(chain, MINTS, run2.keys, walletB, run2.binding);
      })(),
      // Any refusal will do (a fix may refuse in tryCircleKeys or in seedTryCircle); the checks below prove no send.
      () => true,
      "a second checkout seeded the try circle for wallet B after a run had funded wallet A",
    );
    assert.equal(sent, before, "the run with wallet B sent something");
    assert.equal(await lamportsOf(walletB), 0n, "wallet B was funded");
    assert.equal(await tokens(MINTS.usdc, walletB, SPL_TOKEN), 0n);
    assert.equal(await tokens(MINTS.stock, walletB, TOKEN_2022), 0n);
    assert.equal(await raw(tryCircle), null, "a circle was created for wallet B");

    // The binding: public addresses only, 0600, in the keys' own folder; and wallet A, from either checkout, finishes.
    const bindingFile = readFileSync(cli.TRY_BINDING, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(bindingFile)), ["members"]);
    assert.equal(statSync(cli.TRY_BINDING).mode & 0o777, 0o600);
    const run3 = cli.tryRunFor(walletA, DEMO.n - 1);
    assert.deepEqual(run3.keys.map((k) => k.publicKey.toBase58()), keys1.map((k) => k.publicKey.toBase58()));
    const circle = await seedTryCircle(chain, MINTS, run3.keys, walletA, run3.binding);
    assert.ok(circle.equals(tryCircle));
  });
});
