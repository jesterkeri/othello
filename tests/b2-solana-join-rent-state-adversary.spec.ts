/**
 * Adversary on 9268b2e (PR 2): "Claim your seat" is enabled only when nothing the page can know would make the join
 * refuse, including "its SOL for the rent and fee the join costs it". lib/solana-join.ts joinReadiness enables the
 * join for any wallet holding at least joinLamports. But the runtime refuses a transaction that leaves a rent-exempt
 * fee payer holding more than zero and less than the rent-exempt minimum of an empty account
 * (InsufficientFundsForRent). So a wallet holding joinLamports + 1 lamport sees the button enabled and the join fails.
 *
 * Same harness and seed as tests/b2-solana-forming-actions.spec.ts: the DEVNET build in bankrun, ops/demo.ts
 * seedDemoCircle with seats 0, 1 and 2 joined, and the app's own builder (joinAndLockIx), readiness (joinReadiness),
 * least stock (minJoinStock) and SOL figure (joinLamports). Nothing is sent to a public network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, harness, type Harness, fetchAccount } from "./harness.ts";
import { DEMO, seedDemoCircle, type Chain } from "../ops/demo.ts";
import { NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_SPACE, TOKEN_2022, ataAddress, createDevnetMintsIxs, devnetMintAddresses } from "../ops/devnet-mints.ts";
import { joinAndLockIx, type CircleKeys } from "../app/src/lib/actions.ts";
import { minJoinStock } from "../app/src/lib/circle.ts";
import { joinLamports, joinReadiness } from "../app/src/lib/solana-join.ts";
import { decodeLive, memberAddress } from "../app/src/lib/live.ts";

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

describe("adversary on 9268b2e: an enabled join must not be refused for the wallet's SOL", () => {
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

  const raw = async (k: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(k);
    return info ? Buffer.from(info.data) : null;
  };
  const amountAt = async (k: anchor.web3.PublicKey) => {
    const d = await raw(k);
    return d ? d.readBigUInt64LE(64) : null;
  };
  const keys = (circle: anchor.web3.PublicKey): CircleKeys => ({ circle, usdcMint: MINTS.usdc, stockMint: MINTS.stock, members: members.map((m) => m.publicKey) });

  // the seat's wallet holds `extra` lamports more than the page says the join costs it
  const attempt = async (extra: bigint) => {
    const circle = await seedDemoCircle(chain, MINTS, members, [0, 1, 2]);
    const c = await fetchAccount<{ priceFeed: anchor.web3.PublicKey }>(h.program, "circle", circle);
    const view = decodeLive(
      {
        circle: (await raw(circle))!,
        feed: (await raw(c.priceFeed))!,
        mint: (await raw(MINTS.stock))!,
        members: await Promise.all(members.map((m) => raw(memberAddress(h.program.programId, circle, m.publicKey)))),
      },
      "NFLXx mirror",
      Number((await h.context.banksClient.getClock()).unixTimestamp),
    );
    const w = members[3]!;
    const least = minJoinStock(view)!;
    // exactly what SolanaJoin reads and computes for this wallet
    const rentOf = await h.context.banksClient.getRent();
    const solNeeded = joinLamports(
      {
        usdcAccount: (await raw(ataAddress(MINTS.usdc, w.publicKey, SPL_TOKEN))) === null,
        stockVault: (await raw(ataAddress(MINTS.stock, circle, TOKEN_2022))) === null,
        usdcVault: (await raw(ataAddress(MINTS.usdc, circle, SPL_TOKEN))) === null,
      },
      (space) => rentOf.minimumBalance(BigInt(space)),
    );
    h.fund(Number(solNeeded + extra), w);
    const balances = {
      stock: await amountAt(ataAddress(MINTS.stock, w.publicKey, TOKEN_2022)),
      usdc: await amountAt(ataAddress(MINTS.usdc, w.publicKey, SPL_TOKEN)),
      sol: BigInt((await h.context.banksClient.getAccount(w.publicKey))!.lamports),
      solNeeded,
      // since the fix for 9268b2e the page also reads the least a wallet must keep (getMinimumBalanceForRentExemption(0))
      solKeep: rentOf.minimumBalance(0n),
    };
    const ready = joinReadiness(view, least, balances, null, { stock: "NFLXx devnet mirror", usdc: (b) => `${b} test USDC` });
    await h.nextSlot();
    const t = new anchor.web3.Transaction().add(await joinAndLockIx(w.publicKey, keys(circle), least));
    t.recentBlockhash = h.context.lastBlockhash;
    t.feePayer = w.publicKey;
    t.sign(w);
    const refused = await h.context.banksClient.processTransaction(t).then(() => null, (e: unknown) => String(e));
    return { ready, refused };
  };

  // the boundary: holding exactly joinLamports, the wallet ends at zero lamports, which the runtime allows
  it("control: a wallet holding exactly what the page says the join costs joins", async () => {
    const { ready, refused } = await attempt(0n);
    assert.equal(refused, null);
    assert.ok(!ready.enabled || refused === null);
  });

  it("a wallet holding one lamport more than the page says the join costs: if the page enables the join, the join goes through", async () => {
    const { ready, refused } = await attempt(1n);
    assert.ok(!ready.enabled || refused === null, `the page enabled the join (reason ${ready.reason}) and the runtime refused it: ${refused}`);
  });
});
