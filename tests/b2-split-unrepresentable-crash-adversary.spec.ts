/**
 * PR 2 adversary on e0d1637: the page judges the multiplier in force on the wall clock with toFixed1e9
 * (lib/solana-join.ts joinViewAt), which THROWS for a multiplier the app cannot carry exactly, and it does so while
 * rendering. LiveCircle calls joinPriceProblem for every Solana circle, whatever its status, and SolanaJoin calls
 * joinViewAt on every tick. So once a scheduled split to such a multiplier takes effect on the wall clock (after the
 * last read), the whole page throws instead of drawing the last read, where before this PR it drew the last read and
 * the read's own error banner ("The last read of devnet failed (...). Showing the read from ...").
 *
 * The multiplier used, 10000000.123456789, is one Token-2022 accepts (positive, normal) and the program accepts too
 * (valuation.rs decode_multiplier_fixed: floor(m x 1e9) fits a u64); only the app refuses it ("valid on chain but too
 * precise for this app to show exactly", lib/scaledUi.ts toFixed1e9).
 * Harness: tests/b2-forming-page.spec.ts (react-dom/server, LiveCircle's state seeded).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/b2-split-unrepresentable-crash-adversary.spec.ts     (installs hooks: its own process)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

import { REPO } from "./artifacts.ts";
import { CIRCLE_STATES } from "../app/src/fixtures/circles.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "components/circle/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

type G = {
  React?: unknown;
  __seed?: unknown[];
  __n?: number;
  __sets?: unknown[];
  __wallet?: unknown;
  __conn?: unknown;
  __clicks?: Record<string, () => unknown>;
};
const g = globalThis as G;

// LiveCircle's useState, in call order: live, error, pay. Each is seeded from g.__seed and
// every set is recorded in g.__sets.
const REACT_SHIM = `
import R from "${REACT_URL}";
export default R;
export const { useCallback, useEffect, useRef } = R;
export function useState(init) {
  const [v, set] = R.useState(init);
  const k = (globalThis.__n++) % 5; // LiveCircle's useState calls: live, error, pay, lockAmt, topAmt (T18g)
  const seeded = globalThis.__seed && k in globalThis.__seed ? globalThis.__seed[k] : v;
  return [seeded, (x) => { globalThis.__sets.push(x); try { set(x); } catch {} }];
}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
    // the frame (Shell) picks its side from the connected wallets (lib/active-side.ts, since A2): stub that layer as
    // this test stubs the wallet control, so the page renders without the app's wallet providers
    if (specifier === "@/lib/active-side") {
      return { url: "data:text/javascript,export function useActiveSide() { return { side: 'solana', connected: { evm: false, solana: true } }; } export function showsChainSwitch() { return false; }", shortCircuit: true };
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

const mints = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
import type { CircleView } from "../app/src/lib/circle.ts";
import { toFixed1e9 } from "../app/src/lib/scaledUi.ts";

const NOW = Math.floor(Date.now() / 1000);
const A = CIRCLE_STATES.active;
const wallets = A.members.map(() => anchor.web3.Keypair.generate().publicKey.toBase58());
const base: CircleView = {
  ...A,
  members: A.members.map((m, i) => ({ ...m, address: wallets[i]! })),
  status: "Active",
  nextGateShortBy: 0,
  feed: { ...A.feed, updatedAt: NOW - 30 },
};
// Round 1 (index 0): every seat has paid.
const allPaid: CircleView = { ...base, round: 0, paidBitmap: 0b11111, receivedBitmap: 0, defaultedBitmap: 0, roundDeadline: NOW + 60 };
async function buttons(view: CircleView, props: Record<string, unknown> = {}, pay: unknown = { phase: "idle" }, pool = { discountBps: 2000, usdc: 1_000_000_000 }, split = { multiplier: 1, newMultiplier: 1, effectiveAt: 0 }): Promise<{ text: string; on: Record<string, boolean> }> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  g.React = React;
  g.__n = 0;
  g.__seed = [
    {
      view,
      accounts: { circle: "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q", usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
      split,
      pool,
      readAt: NOW,
    },
    null,
    pay,
  ];
  const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, props));
  const on: Record<string, boolean> = {};
  for (const m of html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) on[m[2]!.replace(/&#x27;/g, "'").trim()] = !/\sdisabled=/.test(m[1]!);
  return { text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), on };
}


// A forming circle: seat 1 (the creator) has joined; seats 2 to 5 have not.
const forming: CircleView = { ...base, creator: wallets[0]!, status: "Forming", round: 0, paidBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0, joinedBitmap: 0b00001 };
const as = (i: number) => {
  g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[i]!), sendTransaction: async () => "x" };
};

// valid on chain, too precise for the app (precondition asserted below)
const HUGE = 10000000.123456789;
// the read was taken before the split took effect; the wall clock has since passed it
const split = { multiplier: base.effectiveMultiplier / 1e9, newMultiplier: HUGE, effectiveAt: NOW - 10 };

describe("PR 2 adversary: a split the app cannot carry exactly takes effect after the last read", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__conn = { getAccountInfo: async () => null };
    as(1);
  });

  it("precondition: the multiplier is valid on chain and the app's exact decoder refuses it", () => {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, HUGE, true);
    const bits = v.getBigUint64(0, true);
    const significand = (bits & 0x000f_ffff_ffff_ffffn) | (1n << 52n);
    const exponent = Number((bits >> 52n) & 0x7ffn) - 1023 - 52;
    const fixed = (significand * 1_000_000_000n) >> BigInt(-exponent); // valuation.rs decode_multiplier_fixed
    assert.ok(fixed > 0n && fixed <= 0xffff_ffff_ffff_ffffn, "the program decodes it to a live u64 multiplier");
    assert.throws(() => toFixed1e9(HUGE), /too precise/);
  });

  it("an ACTIVE circle's page still draws the last read (nothing here is about joining)", async () => {
    let out: { text: string } | null = null;
    let thrown: unknown = null;
    try {
      out = await buttons(allPaid, {}, { phase: "idle" }, undefined, split);
    } catch (e) {
      thrown = e;
    }
    assert.equal(thrown, null, `the Active circle's page threw while rendering: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    assert.match(out!.text, /Anyone can move the circle on/);
  });

  it("a FORMING circle's page draws, and Claim your seat says why it waits instead of throwing", async () => {
    let out: { text: string; on: Record<string, boolean> } | null = null;
    let thrown: unknown = null;
    try {
      out = await buttons(forming, {}, { phase: "idle" }, undefined, split);
    } catch (e) {
      thrown = e;
    }
    assert.equal(thrown, null, `the Forming circle's page threw while rendering: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    assert.match(out!.text, /Claim your seat/);
    assert.equal(out!.on[Object.keys(out!.on).find((k) => /^Join(: lock|$)/.test(k))!], false);
  });
});
