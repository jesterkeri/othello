/**
 * A7: the shared single-circle page (Joshua 2026-10-07: the Robinhood page's layout made chain-neutral, Solana moved
 * onto it). What is new for a Solana circle: the shared payout steps in its own words, the shared close-out panel
 * (each joined member withdraws their own seat; no amount, the stock is valued at withdraw time), a seat page with that
 * seat in focus, and no Robinhood word anywhere. Harness: tests/app-live-guards.spec.ts (LiveCircle rendered with
 * react-dom/server, its useState calls seeded, the wallet and the frame's wallet layer stubbed).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page.spec.ts     (installs hooks: its own process)
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

async function buttons(view: CircleView, props: Record<string, unknown> = {}, pool = { discountBps: 2000, usdc: 1_000_000_000 }): Promise<{ text: string; on: Record<string, boolean> }> {
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
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, props));
  const on: Record<string, boolean> = {};
  for (const m of html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) on[m[2]!.replace(/&#x27;/g, "'").trim()] = !/\sdisabled=/.test(m[1]!);
  return { text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), on };
}

import { payoutSteps, type ChainWords } from "../app/src/lib/core/circle-page.ts";
import { RH_WORDS } from "../app/src/lib/robinhood/circle-view.ts";

const SOL_WORDS: ChainWords = { fmt: (b) => `${Number(b) / 1e6} test USDC`, txUrl: (h) => h, chain: "Solana devnet", locked: "NFLXx devnet mirror", testNote: "", payer: "program" };
const ROBINHOOD_WORDS = /USDG|Robinhood|MetaMask|EVM wallet/;

describe("A7: the shared single-circle page", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[1]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  describe("payout steps, in each chain's words", () => {
    const seats = [0, 1, 2].map((turn) => ({ turn, paid: true, defaulted: false, received: false }));
    it("every seat paid: says so, and names the chain that includes the transaction", () => {
      const sol = payoutSteps({ n: 3, round: 1, seats, gateShortBy: 0n, checked: true }, { kind: "idle" }, SOL_WORDS, { coverRefused: false, unfunded: false });
      assert.equal(sol[0]!.detail, "Every seat has paid round 2");
      assert.equal(sol.find((s) => s.key === "pending")!.detail, "Solana devnet includes the transaction");
      const rh = payoutSteps({ n: 3, round: 1, seats, gateShortBy: 0n, checked: true }, { kind: "idle" }, RH_WORDS, { coverRefused: false, unfunded: false });
      assert.equal(rh.find((s) => s.key === "pending")!.detail, "Robinhood Chain includes the transaction");
    });
    it("a seat settled in default is not called paid", () => {
      const withDefault = seats.map((s) => (s.turn === 0 ? { ...s, paid: false, defaulted: true } : s));
      const steps = payoutSteps({ n: 3, round: 1, seats: withDefault, gateShortBy: 0n, checked: true }, { kind: "idle" }, SOL_WORDS, { coverRefused: false, unfunded: false });
      assert.equal(steps[0]!.detail, "Every seat is in for round 2: 2 paid, 1 settled in default");
      assert.equal(steps[0]!.status, "done");
    });
    it("the last check's short figure is shown, in the chain's unit, without blocking the release", () => {
      const steps = payoutSteps({ n: 3, round: 1, seats, gateShortBy: 12_000_000n, checked: true }, { kind: "idle" }, SOL_WORDS, { coverRefused: false, unfunded: false });
      assert.match(steps[1]!.detail, /12 test USDC short\. Releasing checks it again\./);
    });
  });

  describe("a live Solana circle on the shared page", () => {
    it("running: the shared payout panel, Solana words only", async () => {
      const { on, text } = await buttons(allPaid);
      assert.equal(on["Release pot to Ada"], true);
      assert.match(text, /This round's payout/);
      assert.match(text, /Solana devnet includes the transaction/);
      assert.doesNotMatch(text, ROBINHOOD_WORDS, "a Solana visitor never sees a Robinhood word");
    });

    it("completed: a member who has not withdrawn gets Withdraw, with no amount named", async () => {
      const done: CircleView = { ...base, status: "Completed", round: 4, paidBitmap: 0, receivedBitmap: 0b11111, withdrawnBitmap: 0b00001 };
      const { on, text } = await buttons(done);
      assert.equal(on["Withdraw"], true);
      assert.match(text, /All 5 rounds are paid out/);
      assert.match(text, /You collect your locked NFLXx devnet mirror and whatever share of the shared reserve your seat still has/);
      assert.match(text, /1 of 5 shares collected/);
      assert.doesNotMatch(text, ROBINHOOD_WORDS);
    });

    it("completed: a stranger has nothing to collect", async () => {
      g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => "x" };
      const done: CircleView = { ...base, status: "Completed", round: 4, paidBitmap: 0, receivedBitmap: 0b11111, withdrawnBitmap: 0 };
      const { on, text } = await buttons(done);
      assert.equal(on["Withdraw"], undefined);
      assert.match(text, /not a member of this circle, so it has nothing to collect/);
    });

    it("a seat page: that seat first; a join page for a seat not yet joined says joining opens in the next update", async () => {
      const forming: CircleView = { ...base, status: "Forming", round: 0, paidBitmap: 0, receivedBitmap: 0, joinedBitmap: 0b00001 };
      const { text } = await buttons(forming, { seat: 2, kind: "join" });
      assert.match(text, new RegExp(`Seat 2: ${forming.members[1]!.name} \\(you\\)`));
      assert.match(text, /This seat has not joined yet/);
      assert.match(text, /Joining from this page opens in the next update/);
    });

    it("a seat the circle does not have is refused", async () => {
      const { text } = await buttons(allPaid, { seat: 6, kind: "position" });
      assert.match(text, /This circle has 5 seats; there is no seat 6\./);
    });
  });
});
