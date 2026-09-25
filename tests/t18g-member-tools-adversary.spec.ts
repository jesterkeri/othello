/**
 * T18g adversary: the member's own seat tools (SPEC §5) for a seat that has NOT joined.
 * SPEC.md:112 add_stock: "member, not defaulted | Forming (joined) or Active".
 * SPEC.md:114 withdraw: "member | Completed or Cancelled, not withdrawn".
 * live.ts lists every configured seat, joined or not (lockedRaw 0, no Member account), so a wallet
 * whose seat never joined gets `yourTurn`. The program refuses both (add_stock.rs:28, the Member
 * account exists only once the wallet has joined; withdraw.rs:52 the same). The page must not
 * enable them, nor tell that wallet to "withdraw your stock, unused guarantee and top-ups".
 * Harness copied from tests/app-live-guards.spec.ts.
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

describe("T18g adversary: member tools for a seat that never joined", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__conn = {};
  });

  it("Forming, seat 2 has not joined: Lock more stock is not offered as enabled", async () => {
    // Seats 1 and 3 joined; seat 2 (turn 1) has not.
    const forming: CircleView = { ...allPaid, status: "Forming", joinedBitmap: 0b00101, paidBitmap: 0, members: allPaid.members.map((m) => (m.turn === 1 ? { ...m, lockedRaw: 0 } : m)) };
    g.__wallet = { publicKey: new anchor.web3.PublicKey(forming.members[1]!.address), sendTransaction: async () => "x" };
    const { on } = await buttons(forming);
    assert.notEqual(on["Lock 0.1 NFLXx mirror"], true, "add_stock enabled for a seat that has not joined (SPEC.md:112 needs Forming (joined))");
  });

  it("Cancelled in Forming, seat 2 never joined: no Withdraw, no 'withdraw your stock' claim", async () => {
    const cancelled: CircleView = { ...allPaid, status: "Cancelled", joinedBitmap: 0b00101, withdrawnBitmap: 0, paidBitmap: 0, members: allPaid.members.map((m) => (m.turn === 1 ? { ...m, lockedRaw: 0 } : m)) };
    g.__wallet = { publicKey: new anchor.web3.PublicKey(cancelled.members[1]!.address), sendTransaction: async () => "x" };
    const { on, text } = await buttons(cancelled);
    assert.notEqual(on["Withdraw"], true, "withdraw enabled for a wallet with no Member account (SPEC.md:114)");
    assert.doesNotMatch(text, /withdraw your stock, unused guarantee and top-ups/);
  });
});
