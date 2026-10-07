/**
 * A7 adversary, third pass: the shared single-circle page on a Solana circle (PR #27, a76dfd8), against its spec.
 *
 *   Spec 2: "a failed or declined action shows in the round it applies to and nowhere after."
 *   Spec 2: "No step, tick, status line, banner or panel claims something the chain has not done or does not hold."
 *
 * The page follows one transaction at a time (LiveCircle.tsx `pay`), which records what was sent but not the round it
 * was sent in. 74ce48b moved a release's outcome into the payout panel, which drops it once the read leaves its round;
 * every other action (Payment, Default on X, Coverage update, Lock more stock, Top up) still prints its outcome in
 * "Your next step" for as long as no other transaction is sent, whatever round the read is in.
 *
 * 1. Seat 3 pays round 1; the payment lands ("Payment: done."). The others pay, someone releases, and the read is now
 *    round 2, where seat 3 owes again. The page says "your 50 test USDC for round 2 is due" and, under it,
 *    "Payment: done. View the transaction": round 1's payment, shown as done in round 2.
 * 2. Seat 3 declines round 1's payment in the wallet; the read moves to round 2. Round 2's due line carries "Payment:
 *    you declined in your wallet. Nothing was sent."
 * 3. A release sent in round 1 that the wallet sent but devnet did not confirm: the page says "Check the transaction
 *    below", and no link to the transaction is on the page (before 74ce48b "Your next step" carried it; now the payout
 *    panel links a transaction only while pending or released).
 *
 * The seeded `pay` carries `round: 0` (round 1), so a fix that records the round an action was sent in is honoured.
 *
 * Harness: tests/a7-circle-page-adversary.spec.ts (LiveCircle rendered with react-dom/server, its useState and useRef
 * calls seeded, the wallet and the frame's wallet layer stubbed).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-stale-status-adversary.spec.ts     (installs hooks: its own process)
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

async function renderHtml(view: CircleView, pay: unknown, releasing: unknown): Promise<string> {
  // since 84686f9 each transaction on the page carries the wallet that sent it (`by`); a seed without one was sent
  // by the wallet connected here
  if (pay && typeof pay === "object" && (pay as { phase?: string }).phase !== "idle" && !("by" in pay)) {
    pay = { ...(pay as object), by: (g.__wallet as { publicKey: { toBase58(): string } }).publicKey.toBase58() };
  }
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
  return renderToStaticMarkup(React.createElement(LiveCircle, {}));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const SIG = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
// round 2 (index 1): Ada received round 1's pot, nobody has paid round 2 yet; seat 3 (Kemi, the wallet) owes it
const round2: CircleView = { ...base, round: 1, paidBitmap: 0, receivedBitmap: 0b00001, defaultedBitmap: 0, roundDeadline: NOW + 600 };

describe("A7 adversary: an action's outcome stays in the round it was sent in", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[2]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  it("round 1's confirmed payment is not shown as done under round 2's due payment", async () => {
    const t = text(await renderHtml(round2, { phase: "done", what: "Payment", sig: SIG, round: 0 }, null));
    // precondition: the read is round 2 and seat 3 owes it
    assert.match(t, /Seat 3: your 50 test USDC for round 2 is due\./);
    assert.match(t, /Pay 50 test USDC/);
    assert.doesNotMatch(t, /Payment: done\./, "round 1's payment is still shown as done while round 2's is due");
  });

  it("round 1's declined payment is not shown in round 2", async () => {
    const t = text(await renderHtml(round2, { phase: "failed", what: "Payment", reason: "you declined in your wallet. Nothing was sent.", round: 0 }, null));
    assert.match(t, /Seat 3: your 50 test USDC for round 2 is due\./);
    assert.doesNotMatch(t, /you declined in your wallet/, "a payment declined in round 1 is still shown in round 2");
  });

  it("a sent but unconfirmed release that says 'Check the transaction below' has that transaction on the page", async () => {
    const pay = { phase: "failed", what: "Release pot to Ada", reason: "sent, but not confirmed: block height exceeded. Check the transaction below.", sig: SIG, round: 0 };
    const releasing = { round: 0, turn: 0, amount: BigInt(base.contribution) * BigInt(base.n) };
    // still round 1 by the read: every seat paid, Ada's turn
    const round1: CircleView = { ...base, round: 0, paidBitmap: 0b11111, receivedBitmap: 0, defaultedBitmap: 0 };
    const html = await renderHtml(round1, pay, releasing);
    assert.match(text(html), /Check the transaction below/, "precondition: the page points to the transaction");
    assert.ok(html.includes(SIG), "the page says 'Check the transaction below', yet no link to the sent release is on it");
  });
});
