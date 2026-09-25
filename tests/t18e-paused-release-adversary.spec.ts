/**
 * T18e adversary: SPEC.md §5 (the Paused paragraph under the payout gate) says Paused "is as of
 * the last update_coverage / release_pot / declare_default / top_up_reserve; add_stock and price
 * changes do not refresh it. The UI shows the last-checked age next to Paused and never disables
 * Release pot on it: the program refuses with numbers if the gate fails."
 *
 * Sequence, on the devnet build in bankrun after the real demo seed (ops/demo.ts):
 *   every seat pays round 1; the admin drops the price; anyone sends update_coverage, so
 *   next_gate_short_by > 0 (Paused); the admin restores the demo price. Paused is now stale.
 * The app's LiveCircle, rendered from the same accounts (the render harness of
 * app-live-guards.spec.ts), disables "Release pot to seat 1" and says it waits "until a member tops
 * up". The program then accepts release_pot from a stranger, with no top-up.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

import { REPO, TOOLCHAIN_PATH } from "./artifacts.ts";
import { BEFORE_SPLIT, CURRENT, ONE_X, fetchAccount, harness, setPrices, type Harness } from "./harness.ts";
import { DEMO, addresses, payRound, seedDemoCircle, type Chain } from "../ops/demo.ts";
import { NFLXX_MIRROR_SPACE, SPL_TOKEN, TEST_USDC_SPACE, ataAddress, createDevnetMintsIxs, devnetMintAddresses } from "../ops/devnet-mints.ts";
import { releasePotIx, updateCoverageIx, type CircleKeys } from "../app/src/lib/actions.ts";
import { decodeLive, memberAddress } from "../app/src/lib/live.ts";
import type { CircleView } from "../app/src/lib/circle.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "components/circle/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

type G = { React?: unknown; __seed?: unknown[]; __n?: number; __sets?: unknown[]; __wallet?: unknown; __conn?: unknown };
const g = globalThis as G;

// The render harness of tests/app-live-guards.spec.ts, unchanged.
const REACT_SHIM = `
import R from "${REACT_URL}";
export default R;
export const { useCallback, useEffect, useRef } = R;
export function useState(init) {
  const [v, set] = R.useState(init);
  const k = (globalThis.__n++) % 3;
  const seeded = globalThis.__seed && k in globalThis.__seed ? globalThis.__seed[k] : v;
  return [seeded, (x) => { globalThis.__sets.push(x); try { set(x); } catch {} }];
}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
    if (specifier === "@/components/othello/WalletConnect" || specifier === "./WalletConnect") {
      return { url: "data:text/javascript,export function WalletControl() { return null; }", shortCircuit: true };
    }
    if (specifier === "@solana/wallet-adapter-react") {
      return {
        url: "data:text/javascript,export function useConnection() { return { connection: globalThis.__conn }; } export function useWallet() { return globalThis.__wallet; }",
        shortCircuit: true,
      };
    }
    if (specifier === "react" && context.parentURL?.endsWith("/live/LiveCircle.tsx")) {
      return { url: `data:text/javascript,${encodeURIComponent(REACT_SHIM)}`, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    return next(specifier, context);
  },
});

const DEVNET_SO = "target/devnet/othello.so";
const record = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const MINTS = { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) };

async function render(view: CircleView, pool: { discountBps: number; usdc: number }, now: number): Promise<{ text: string; on: Record<string, boolean> }> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  g.React = React;
  g.__n = 0;
  g.__sets = [];
  g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => "x" };
  g.__conn = {};
  g.__seed = [
    { view, accounts: { circle: "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q", usdcMint: record.testUsdc, stockMint: record.nflxxMirror }, split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 }, pool, readAt: now },
    null,
    { phase: "idle" },
  ];
  const real = Date.now;
  try {
    Date.now = () => now * 1000; // the page's wall clock is the chain's clock
    const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
    const html: string = renderToStaticMarkup(React.createElement(LiveCircle));
    const on: Record<string, boolean> = {};
    for (const m of html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) on[m[2]!.replace(/&#x27;/g, "'").trim()] = !/\sdisabled=/.test(m[1]!);
    return { text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), on };
  } finally {
    Date.now = real;
  }
}

describe("T18e adversary: a stale Paused disables a release the program accepts (SPEC §5 Paused)", () => {
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

  const sendAs = async (ix: anchor.web3.TransactionInstruction, signer: anchor.web3.Keypair) => {
    await h.nextSlot();
    const t = new anchor.web3.Transaction().add(ix);
    t.recentBlockhash = h.context.lastBlockhash;
    t.feePayer = signer.publicKey;
    t.sign(signer);
    await h.context.banksClient.processTransaction(t);
  };
  const keys = (circle: anchor.web3.PublicKey): CircleKeys => ({ circle, usdcMint: MINTS.usdc, stockMint: MINTS.stock, members: members.map((m) => m.publicKey) });
  const raw = async (k: anchor.web3.PublicKey) => Buffer.from((await h.context.banksClient.getAccount(k))!.data);

  it("Release pot is disabled while the program releases the pot", async () => {
    const circle = await seedDemoCircle(chain, MINTS, members);
    await payRound(chain, MINTS, members);
    const stranger = h.fund();

    // A price drop, read by update_coverage: Paused.
    await h.nextSlot();
    await setPrices(h, MINTS.stock, { wrapper: 50 * 1_000_000, share: 50 * 1_000_000, stamp: CURRENT, expected: ONE_X });
    await sendAs(await updateCoverageIx(stranger.publicKey, keys(circle)), stranger);
    // The price comes back. SPEC §5: price changes do not refresh next_gate_short_by.
    await h.nextSlot();
    await setPrices(h, MINTS.stock, { wrapper: DEMO.wrapperPrice, share: DEMO.sharePrice, stamp: CURRENT, expected: ONE_X });

    // What the app reads and shows.
    const a = addresses(h.program, MINTS, members[0]!.publicKey);
    const now = Number((await h.context.banksClient.getClock()).unixTimestamp);
    const view = decodeLive(
      {
        circle: await raw(circle),
        feed: await raw(a.feed),
        mint: await raw(MINTS.stock),
        members: await Promise.all(members.map((m) => raw(memberAddress(h.program.programId, circle, m.publicKey)))),
      },
      "NFLXx mirror",
      now,
    );
    const pool = await fetchAccount<{ discountBps: number }>(h.program, "liquidationPool", a.pool);
    const poolUsdc = Number(Buffer.from((await h.context.banksClient.getAccount(ataAddress(MINTS.usdc, a.pool, SPL_TOKEN)))!.data).readBigUInt64LE(64));
    assert.ok(view.nextGateShortBy > 0, "setup: the circle should read as Paused");
    const shown = await render(view, { discountBps: pool.discountBps, usdc: poolUsdc }, now);
    const release = Object.keys(shown.on).find((k) => k.startsWith("Release pot"))!;

    // The program, with no top-up.
    let refused: unknown = null;
    await sendAs(await releasePotIx(stranger.publicKey, keys(circle), members[0]!.publicKey), stranger).catch((e: unknown) => (refused = e));
    assert.equal(refused, null, `setup: the program should accept the release: ${String(refused)}`);
    assert.equal((await fetchAccount<{ round: number }>(h.program, "circle", circle)).round, 1, "the program released the pot");

    // SPEC §5: the UI never disables Release pot on Paused, and no text claims only a top-up can resume it.
    assert.equal(shown.on[release], true, `"${release}" was disabled; the page said: ${shown.text.match(/Every seat is settled[^.]*\.[^.]*\./)?.[0]}`);
  });
});
