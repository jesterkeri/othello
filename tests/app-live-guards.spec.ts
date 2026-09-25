/**
 * Codex T18d r1 (MAJOR): the live circle's anyone-may-send buttons must be enabled only when every
 * condition the read already knows holds (brief §1). SPEC §5 and the program's refusals:
 *   release_pot      every seat paid or defaulted; price fresh (price_stale); not repricing
 *                    (multiplier_price_mismatch); the gate (reserve_overcommitted, i.e. Paused)
 *   update_coverage  Active; price fresh; not repricing
 *   declare_default  strictly after deadline + grace; received, unpaid, not defaulted; price fresh;
 *                    pool USDC >= recovered (pool_insufficient, SPEC §6)
 * Each state renders LiveCircle with react-dom/server (the adversary's harness in
 * t18d-anyone-actions-adversary.spec.ts) with a connected wallet, and reads each button's disabled
 * attribute from the markup.
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
import { defaultRecovered, type CircleView } from "../app/src/lib/circle.ts";

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
// Round 2: Ada took round 1's pot and has not paid; the others have; grace ended 5s ago.
const adaLate: CircleView = {
  ...base,
  round: 1,
  paidBitmap: 0b11110,
  receivedBitmap: 0b00001,
  defaultedBitmap: 0,
  members: base.members.map((m) => (m.turn === 0 ? { ...m, roundsPaid: 1 } : m)),
  roundDeadline: NOW - base.graceSecs - 5,
};
const needs = defaultRecovered(adaLate, adaLate.members[0]!, 2000);

async function buttons(view: CircleView, pool = { discountBps: 2000, usdc: 1_000_000_000 }): Promise<{ text: string; on: Record<string, boolean> }> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  g.React = React;
  g.__n = 0;
  g.__seed = [
    {
      view,
      accounts: { circle: "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q", usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
      split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
      pool,
      readAt: NOW,
    },
    null,
    { phase: "idle" },
  ];
  const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle));
  const on: Record<string, boolean> = {};
  for (const m of html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) on[m[2]!.replace(/&#x27;/g, "'").trim()] = !/\sdisabled=/.test(m[1]!);
  return { text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), on };
}

describe("T18e: the live circle's buttons follow every known program condition (Codex T18d r1)", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => "x" };
    g.__conn = {};
  });

  it("control: every seat paid, fresh price, not paused: Release and Update coverage are enabled", async () => {
    const { on, text } = await buttons(allPaid);
    assert.equal(on["Release pot to Ada"], true);
    assert.equal(on["Update coverage"], true);
    assert.match(text, /anyone can release the pot to Ada/);
  });

  it("stale price: Release and Update coverage are disabled, and the page says why", async () => {
    const { on, text } = await buttons({ ...allPaid, feed: { ...allPaid.feed, updatedAt: NOW - allPaid.maxPriceAge - 60 } });
    assert.equal(on["Release pot to Ada"], false);
    assert.equal(on["Update coverage"], false);
    assert.match(text, /acts only on a fresh one/);
    assert.doesNotMatch(text, /anyone can release the pot/);
  });

  it("repricing: Release and Update coverage are disabled, and the page says why", async () => {
    const { on, text } = await buttons({ ...allPaid, feed: { ...allPaid.feed, pricedForMultiplier: allPaid.effectiveMultiplier + 1 } });
    assert.equal(on["Release pot to Ada"], false);
    assert.equal(on["Update coverage"], false);
    assert.match(text, /repricing/);
    assert.doesNotMatch(text, /anyone can release the pot/);
  });

  it("paused (next_gate_short_by > 0): Release stays enabled (SPEC.md:129), and the page says the program re-checks", async () => {
    // SPEC.md:129: the UI "never disables Release pot on it: the program refuses with numbers if the
    // gate fails". Paused is as of the last coverage check; release_pot recomputes the gate itself.
    const { on, text } = await buttons({ ...allPaid, nextGateShortBy: 12_000_000 });
    assert.equal(on["Release pot to Ada"], true);
    assert.equal(on["Update coverage"], true);
    assert.match(text, /payouts were paused, 12\.00 test USDC short/);
    assert.match(text, /the program re-checks the reserve/);
    assert.doesNotMatch(text, /until a member tops up/);
  });

  it("a feed that was never priced (prices 0, fresh stamp): Release, Update and Declare are disabled", async () => {
    const unpriced = { ...allPaid.feed, wrapperPrice: 0, sharePrice: 0 };
    const a = await buttons({ ...allPaid, feed: unpriced });
    assert.equal(a.on["Release pot to Ada"], false);
    assert.equal(a.on["Update coverage"], false);
    assert.match(a.text, /No price has been set/);
    const b = await buttons({ ...adaLate, feed: { ...adaLate.feed, wrapperPrice: 0, sharePrice: 0 } });
    assert.equal(b.on["Declare Ada in default"], false);
  });

  it("control: Ada past grace, pool holds enough: Declare Ada in default is enabled", async () => {
    assert.ok(needs > 0, "the default needs the pool to pay something");
    const { on } = await buttons(adaLate, { discountBps: 2000, usdc: needs });
    assert.equal(on["Declare Ada in default"], true);
    assert.equal(on["Release pot to Tunde"], false);
  });

  it("pool one unit short of recovered: Declare is disabled, and the page names both amounts", async () => {
    const { on, text } = await buttons(adaLate, { discountBps: 2000, usdc: needs - 1 });
    assert.equal(on["Declare Ada in default"], false);
    assert.match(text, /liquidation pool holds/);
  });

  it("stale price: Declare is disabled", async () => {
    const { on } = await buttons({ ...adaLate, feed: { ...adaLate.feed, updatedAt: NOW - adaLate.maxPriceAge - 60 } });
    assert.equal(on["Declare Ada in default"], false);
  });

  it("at exactly deadline + grace there is no Declare button; one second later there is", async () => {
    // The page decides by the browser clock; pin it so the boundary is exact.
    const real = Date.now;
    try {
      Date.now = () => NOW * 1000;
      assert.equal("Declare Ada in default" in (await buttons({ ...adaLate, roundDeadline: NOW - adaLate.graceSecs })).on, false);
      Date.now = () => (NOW + 1) * 1000;
      assert.equal("Declare Ada in default" in (await buttons({ ...adaLate, roundDeadline: NOW - adaLate.graceSecs })).on, true);
    } finally {
      Date.now = real;
    }
  });
  // T18g: the member's own seat tools, shown only to the connected member.
  it("a member of an Active circle can lock more stock and top up; a stranger sees neither", async () => {
    g.__wallet = { publicKey: new anchor.web3.PublicKey(allPaid.members[1]!.address), sendTransaction: async () => "x" };
    const m = await buttons(allPaid);
    assert.equal(m.on["Lock 0.1 NFLXx mirror"], true);
    assert.equal(m.on["Top up 10 test USDC"], true);
    assert.equal("Withdraw" in m.on, false);
    g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => "x" };
    const s = await buttons(allPaid);
    assert.equal("Lock 0.1 NFLXx mirror" in s.on, false);
    assert.equal("Top up 10 test USDC" in s.on, false);
  });

  it("a defaulted member cannot add stock or top up; once the circle ends, a member who has not withdrawn can", async () => {
    g.__wallet = { publicKey: new anchor.web3.PublicKey(adaLate.members[0]!.address), sendTransaction: async () => "x" };
    const d = await buttons({ ...adaLate, defaultedBitmap: 0b00001 });
    assert.equal("Lock 0.1 NFLXx mirror" in d.on, false);
    assert.match(d.text, /This seat has defaulted/);
    const done = await buttons({ ...allPaid, status: "Completed", withdrawnBitmap: 0 });
    assert.equal(done.on["Withdraw"], true);
    const gone = await buttons({ ...allPaid, status: "Completed", withdrawnBitmap: 0b00001 });
    assert.equal("Withdraw" in gone.on, false);
  });
});
