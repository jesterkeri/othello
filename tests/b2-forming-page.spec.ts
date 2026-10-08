/**
 * PR 2 (Joshua 2026-10-08): a forming Solana circle's own steps on the shared page. Who sees "Claim your seat", "Your
 * seat is locked" (leave) and the creator's Start / Cancel, when each is enabled, why it is not, and the outcome of a
 * Start or Cancel shown in the state it caused. joinReadiness (components/live/SolanaJoin.tsx) is tested directly.
 * Harness: tests/a7-circle-page.spec.ts.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/b2-forming-page.spec.ts     (installs hooks: its own process)
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
import { minJoinStock, type CircleView } from "../app/src/lib/circle.ts";
import { joinReadiness } from "../app/src/lib/solana-join.ts";

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

async function buttons(view: CircleView, props: Record<string, unknown> = {}, pay: unknown = { phase: "idle" }, pool = { discountBps: 2000, usdc: 1_000_000_000 }): Promise<{ text: string; on: Record<string, boolean> }> {
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
const full: CircleView = { ...forming, joinedBitmap: 0b11111 };
const as = (i: number) => {
  g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[i]!), sendTransaction: async () => "x" };
};
const SIG = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const WORDS = { stock: "NFLXx devnet mirror", usdc: (b: bigint) => `${(Number(b) / 1e6).toFixed(2)} test USDC` };

describe("PR 2: a forming Solana circle's own steps", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__conn = { getAccountInfo: async () => null };
    as(1);
  });

  describe("joinReadiness: the join is enabled only when the program would take it, else it says why", () => {
    const least = minJoinStock(forming)!;
    const rich = { stock: least * 10n, usdc: BigInt(forming.guaranteePerMember), sol: 10_000_000n, solNeeded: 1_724_120n };
    it("enough stock and the guarantee: enabled", () => {
      assert.deepEqual(joinReadiness(forming, least, rich, null, WORDS), { enabled: true, reason: null });
    });
    it("one raw unit under the least: refused, naming the least", () => {
      const r = joinReadiness(forming, least - 1n, rich, null, WORDS);
      assert.equal(r.enabled, false);
      assert.match(r.reason!, /needs at least/);
    });
    it("no stock account, too little stock, too little test USDC, still reading, or blocked: refused with the reason", () => {
      assert.match(joinReadiness(forming, least, { ...rich, stock: null }, null, WORDS).reason!, /no NFLXx devnet mirror account/);
      assert.match(joinReadiness(forming, least, { ...rich, stock: least - 1n }, null, WORDS).reason!, /holds .* needs/);
      assert.match(joinReadiness(forming, least, { ...rich, usdc: rich.usdc - 1n }, null, WORDS).reason!, /the guarantee is 35\.00 test USDC/);
      assert.match(joinReadiness(forming, least, { ...rich, sol: rich.solNeeded - 1n }, null, WORDS).reason!, /joining needs 0\.00172412 for the seat account's rent and the fee/);
      assert.match(joinReadiness(forming, least, "reading", null, WORDS).reason!, /Reading/);
      assert.match(joinReadiness(forming, least, "failed", null, WORDS).reason!, /could not be read/);
      assert.equal(joinReadiness(forming, least, rich, "The price is 2d old", WORDS).reason, "The price is 2d old");
    });
  });

  it("a seat that has not joined sees Claim your seat; a wallet with no seat does not", async () => {
    const seat = await buttons(forming);
    assert.match(seat.text, /Claim your seat/);
    assert.equal(Object.keys(seat.on).some((k) => k.startsWith("Join: lock")), true, "a usable price names the amount");
    g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => "x" };
    const stranger = await buttons(forming);
    assert.doesNotMatch(stranger.text, /Claim your seat/);
  });

  it("the join waits for a fresh price, and says so", async () => {
    const stale: CircleView = { ...forming, feed: { ...forming.feed, updatedAt: NOW - forming.maxPriceAge - 60 } };
    const { text, on } = await buttons(stale);
    const join = Object.keys(on).find((k) => /^Join(: lock|$)/.test(k))!;
    assert.equal(on[join], false);
    assert.match(text, /old, and joining needs a fresh one/);
  });

  it("while price and split disagree, the join names no minimum or cover figure, and says why it waits", async () => {
    // the feed priced for x10 while the mint is at x1 (the split in force): join_and_lock refuses MultiplierPriceMismatch
    const repricing: CircleView = { ...forming, feed: { ...forming.feed, pricedForMultiplier: forming.effectiveMultiplier * 10 } };
    const { text, on } = await buttons(repricing);
    assert.equal(on[Object.keys(on).find((k) => /^Join(: lock|$)/.test(k))!], false);
    assert.match(text, /joining waits for a price set for the new multiplier/);
    assert.doesNotMatch(text, /needs at least/);
    assert.doesNotMatch(text, /counts as .* of cover at the current price/);
  });

  it("a joined seat can leave while the circle forms", async () => {
    const two: CircleView = { ...forming, joinedBitmap: 0b00011 };
    const { text, on } = await buttons(two);
    assert.match(text, /Your seat is locked/);
    assert.equal(on["Leave and take them back"], true);
  });

  it("the creator: Start waits for every seat, Cancel is open; nobody else sees either", async () => {
    as(0);
    const early = await buttons(forming);
    assert.match(early.text, /4 of 5 seats still to join/);
    assert.equal(early.on["Start the circle"], false);
    assert.equal(early.on["Cancel the circle"], true);
    const ready = await buttons(full);
    assert.match(ready.text, /Every seat has joined: starting opens round 1/);
    assert.equal(ready.on["Start the circle"], true);
    as(1);
    const member = await buttons(full);
    assert.equal("Start the circle" in member.on, false);
    assert.equal("Cancel the circle" in member.on, false);
  });

  it("while another wallet's transaction is in flight, nothing here can be sent", async () => {
    as(0);
    const inFlight = { phase: "confirming", what: "Join", sig: SIG, round: 0, status: "Forming", by: wallets[3]! };
    const { text, on } = await buttons(full, {}, inFlight);
    assert.equal(on["Start the circle"], false);
    assert.equal(on["Cancel the circle"], false);
    assert.match(text, /Another wallet's transaction is still waiting/);
  });

  it("a done Start is still shown once the read says Active, and a done Cancel once it says Cancelled", async () => {
    as(0);
    const started = await buttons({ ...full, status: "Active", roundDeadline: NOW + 120 }, {}, { phase: "done", what: "Start the circle", sig: SIG, round: 0, status: "Forming", by: wallets[0]! });
    assert.match(started.text, /Start the circle: done\./);
    const cancelled = await buttons({ ...forming, status: "Cancelled" }, {}, { phase: "done", what: "Cancel the circle", sig: SIG, round: 0, status: "Forming", by: wallets[0]! });
    assert.match(cancelled.text, /Cancel the circle: done\./);
    // any other finished outcome from the forming circle is still not carried into the running one
    const joinDone = await buttons({ ...full, status: "Active", roundDeadline: NOW + 120 }, {}, { phase: "done", what: "Join", sig: SIG, round: 0, status: "Forming", by: wallets[0]! });
    assert.doesNotMatch(joinDone.text, /Join: done\./);
  });
});
