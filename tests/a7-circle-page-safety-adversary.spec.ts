/**
 * A7 adversary, second pass: the shared payout panel on a Solana circle (PR #27, 74ce48b), against its spec.
 *
 *   Spec 2: "The payout steps, status lines and confirmations never claim something the chain has not done."
 *
 * The "Payout safety" step reads the payout gate's stored result (next_gate_short_by), which only update_coverage,
 * release_pot, declare_default and top_up_reserve write (SPEC.md:129). release_pot runs the gate again itself and
 * refuses with ReserveOvercommitted when it fails (programs/othello/src/instructions/release_pot.rs).
 *
 * 1. The last check found the reserve short (the page shows "Payouts paused"), and a member sends the release anyway,
 *    as SPEC.md:129 allows. While the wallet asks, and while the transaction is pending, the step turns to done and
 *    says "The reserve covers the next rounds": the chain has not run the gate yet, and its last run said the
 *    opposite.
 * 2. A circle whose coverage has never been computed (last_coverage_at 0; the page's own footer says so): once every
 *    seat has paid, the step is done and says "The reserve covers the next rounds", a check the chain never ran.
 * 3. The close-out panel tells a defaulted member whose whole stock was sold that they collect their locked stock;
 *    withdraw transfers none (its stock_raw, in the page's own read, is 0).
 *
 * Harness: tests/a7-circle-page-adversary.spec.ts (LiveCircle rendered with react-dom/server, its useState and useRef
 * calls seeded, the wallet and the frame's wallet layer stubbed).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-safety-adversary.spec.ts     (installs hooks: its own process)
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
  __refs?: unknown[];
  __n?: number;
  __rn?: number;
  __sets?: unknown[];
  __wallet?: unknown;
  __conn?: unknown;
};
const g = globalThis as G;

// LiveCircle's useState calls, in order: live, error, pay, lockAmt, topAmt; its useRef calls: latest, releasing.
const REACT_SHIM = `
import R from "${REACT_URL}";
export default R;
export const { useCallback, useEffect } = R;
export function useState(init) {
  const [v, set] = R.useState(init);
  const k = (globalThis.__n++) % 5;
  const seeded = globalThis.__seed && k in globalThis.__seed ? globalThis.__seed[k] : v;
  return [seeded, (x) => { globalThis.__sets.push(x); try { set(x); } catch {} }];
}
export function useRef(init) {
  const r = R.useRef(init);
  const k = (globalThis.__rn++) % 2;
  if (globalThis.__refs && k in globalThis.__refs) r.current = globalThis.__refs[k];
  return r;
}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
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

async function render(view: CircleView, pay: unknown, releasing: unknown): Promise<string> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  g.React = React;
  g.__n = 0;
  g.__rn = 0;
  g.__seed = [
    {
      view,
      accounts: { circle: "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q", usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
      split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
      pool: { discountBps: 2000, usdc: 1_000_000_000 },
      readAt: NOW,
    },
    null,
    pay,
  ];
  g.__refs = [1, releasing];
  const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, {}));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

// Round 1 (index 0): every seat has paid, the price is fresh, Ada (turn 0) receives.
const allPaid: CircleView = { ...base, round: 0, paidBitmap: 0b11111, receivedBitmap: 0, defaultedBitmap: 0, roundDeadline: NOW + 60 };
const releasing = { round: 0, turn: 0, amount: BigInt(base.contribution) * BigInt(base.n) };
// the step as the page renders it: its label, then its detail
const CLAIM = /Payout safety The reserve covers the next rounds/;
const step = (text: string) => text.slice(text.indexOf("Payments"), text.indexOf("Pending on chain"));

describe("A7 adversary: the payout safety step on a Solana circle", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[2]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  describe("the last check found the reserve short, and a member sends the release anyway", () => {
    // the stored gate result: 5 test USDC short, checked 40s ago
    const paused: CircleView = { ...allPaid, nextGateShortBy: 5_000_000, lastCoverageAt: NOW - 40 };

    it("idle: the step names the last check's shortfall (control)", async () => {
      const text = await render(paused, { phase: "idle" }, null);
      assert.match(text, /Payouts paused\./);
      assert.match(text, /Last check found the reserve 5\.00 test USDC short/);
    });

    it("waiting for the wallet: the step does not say the reserve covers the next rounds", async () => {
      const text = await render(paused, { phase: "wallet", what: "Release pot to Ada" }, releasing);
      assert.match(text, /Confirm the release in your wallet/, "precondition: the release is waiting for the wallet");
      assert.match(text, /Payouts paused\./, "precondition: the same read still says the last check was short");
      assert.doesNotMatch(text, CLAIM, `the chain has not run the gate, and its last run found the reserve short: "${step(text)}"`);
    });

    it("sent, not yet included: the step does not say the reserve covers the next rounds", async () => {
      const text = await render(paused, { phase: "confirming", what: "Release pot to Ada", sig: "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn" }, releasing);
      assert.match(text, /Sent\. Waiting for Solana devnet to include it/, "precondition: the release is pending");
      assert.match(text, /Payouts paused\./, "precondition: the same read still says the last check was short");
      assert.doesNotMatch(text, CLAIM, `the chain has not run the gate, and its last run found the reserve short: "${step(text)}"`);
    });
  });

  it("coverage never computed: the step does not say the reserve covers the next rounds", async () => {
    const never: CircleView = { ...allPaid, nextGateShortBy: 0, lastCoverageAt: 0 };
    const text = await render(never, { phase: "idle" }, null);
    assert.match(text, /Coverage has not been computed yet/, "precondition: the page's own footer says no check has run");
    assert.match(text, /Release pot to Ada/, "precondition: the panel offers the release");
    assert.doesNotMatch(text, CLAIM, `no coverage check has ever run on this circle: "${step(text)}"`);
  });

  // 3. The close-out panel. declare_default sells min(stock_raw, what the seat owes) of a defaulted seat's stock
  //    (declare_default.rs), so all of it when the stock is worth less than the debt; withdraw then transfers stock
  //    only when stock_raw > 0 (withdraw.rs). The page's own read has the seat's stock_raw (lockedRaw).
  it("completed: a defaulted seat whose stock was all sold is not promised its locked stock", async () => {
    const done: CircleView = {
      ...base,
      status: "Completed",
      round: 4,
      paidBitmap: 0,
      receivedBitmap: 0b11111,
      defaultedBitmap: 0b00100,
      withdrawnBitmap: 0,
      // seat 3 (the connected wallet) defaulted and its whole stock was sold to the liquidation pool
      members: base.members.map((m) => (m.turn === 2 ? { ...m, lockedRaw: 0 } : m)),
    };
    const text = await render(done, { phase: "idle" }, null);
    assert.match(text, /Seat 3 \(you\)/, "precondition: the connected wallet is seat 3");
    assert.match(text, /Withdraw/, "precondition: the close-out offers the withdrawal");
    const said = /You collect[^.]*\./.exec(text)?.[0] ?? "";
    assert.doesNotMatch(said, /your locked NFLXx devnet mirror/, `seat 3 has no stock left to collect, yet: "${said}"`);
  });
});
