/**
 * A7 adversary, eleventh pass: the shared single-circle page on a Solana circle (PR #27, 401fac3), against its spec.
 *
 *   Spec 2: "No step, tick, status line, banner, chip or panel claims something the chain has not done or does not
 *   hold, in any circle status (Forming, Active, Completed, Cancelled)".
 *
 * Case 1: the ring's seat list on a defaulted seat whose stock did not cover its default. ringOf (lib/core/ring.ts)
 * calls a defaulted, unpaid seat "settled in default: covered by locked <collateral>" whenever the escrow holds this
 * round's share, and LiveCircle passes the stock ("NFLXx devnet mirror") as the collateral. SPEC.md section 6: the
 * stock is sold up to what the seat owes and the reserve pays the shortfall (loss); what the reserve cannot is the
 * escrow deficit. cda5631 and 401fac3 reworded "Your next step" for exactly this ("were covered from its stock" was
 * untrue); the ring on the same page still says it.
 * State: 401fac3's own escrow-deficit case (tests/a7-circle-page-forming-deficit-adversary.spec.ts): the demo circle
 * (SPEC.md:134) after its stock fell to 25 USDC a token; seat 1 received round 1's pot, missed round 2 and was declared
 * in default. SPEC section 6: O = 200, recovered = 22 (all 1.1 token sold), loss = 175 from the reserve, escrow = 197,
 * escrow_deficit = 3. The escrow holds this round's 50, so the ring marks the seat "covered".
 *
 * Case 2: a Cancelled circle (cancel_circle: creator, Forming only; SPEC.md:105) never runs a round, yet its turn order
 * lists every round as "Upcoming" and each member card's Pot chip reads "Waiting".
 * State: CIRCLE_STATES.cancelled (the repo's fixture).
 *
 * Harness: tests/a7-circle-page-forming-deficit-adversary.spec.ts (LiveCircle rendered with react-dom/server, its
 * useState and useRef calls seeded, the wallet and the frame's wallet layer stubbed). No network.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-ring-default-adversary.spec.ts     (installs hooks: its own process)
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

async function render(view: CircleView, pay: unknown, releasing: unknown, props: Record<string, unknown> = {}): Promise<string> {
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
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, props));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

const USDC = 1_000_000;

describe("A7 adversary: the ring names who covered a default; a cancelled circle has no rounds to come", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__conn = {};
  });

  // SPEC section 6 by hand, on the demo circle's parameters and a 25 USDC wrapper price
  const WRAPPER = 25 * USDC;
  const O = 50 * USDC * 4;
  const conservative = (WRAPPER * (10_000 - 2000)) / 10_000;
  const sellRaw = Math.min(110_000_000, Math.ceil((O * 1e8) / conservative));
  const recovered = Math.floor((sellRaw * conservative) / 1e8);
  const shortfall = O - Math.min(O, recovered);
  const loss = Math.min(shortfall, 175 * USDC);
  const deficit = shortfall - loss;

  const shortDefault: CircleView = {
    ...base,
    round: 1,
    paidBitmap: 0b11110,
    receivedBitmap: 0b00001,
    defaultedBitmap: 0b00001,
    reserveLosses: loss,
    reserveAllocated: 0,
    escrow: Math.min(O, recovered) + loss,
    escrowDeficit: deficit,
    nextGateShortBy: deficit,
    roundDeadline: NOW + 60,
    feed: { ...base.feed, wrapperPrice: WRAPPER, sharePrice: WRAPPER },
    members: base.members.map((m) => (m.turn === 0 ? { ...m, lockedRaw: 110_000_000 - sellRaw, roundsPaid: 1, allocated: 0 } : m)),
  };

  it("a default the stock did not cover is not called covered by the locked stock", async () => {
    assert.equal(sellRaw, 110_000_000, "precondition: the default sold all of seat 1's stock");
    assert.equal(recovered, 22 * USDC, "precondition: the stock raised 22 of the 200 owed");
    assert.equal(loss, 175 * USDC, "precondition: the reserve paid 175");
    assert.equal(deficit, 3 * USDC, "precondition: 3 are still the escrow's deficit");
    g.__wallet = { publicKey: null, sendTransaction: async () => "x" };
    const text = await render(shortDefault, { phase: "idle" }, null);
    assert.match(text, /Has received a pot, settled in default/, "precondition: the ring lists seat 1 as settled in default");
    assert.doesNotMatch(
      text,
      /settled in default: covered by locked NFLXx devnet mirror/,
      "seat 1's stock raised 22 test USDC of the 200 owed; the reserve paid 175 and 3 are an escrow deficit (SPEC.md section 6)",
    );
  });

  const cancelled: CircleView = {
    ...CIRCLE_STATES.cancelled,
    members: CIRCLE_STATES.cancelled.members.map((m, i) => ({ ...m, address: wallets[i]! })),
    feed: { ...CIRCLE_STATES.cancelled.feed, updatedAt: NOW - 30 },
  };

  it("a Cancelled circle does not list rounds as upcoming or seats as waiting for a pot", async () => {
    g.__wallet = { publicKey: null, sendTransaction: async () => "x" };
    const text = await render(cancelled, { phase: "idle" }, null);
    assert.match(text, /This circle was cancelled/, "precondition: the page shows the circle cancelled");
    assert.doesNotMatch(text, /Upcoming/, "cancel_circle runs only while Forming (SPEC.md:105): no round of this circle will ever run");
    assert.doesNotMatch(text, /Pot Waiting/, "no seat of a cancelled circle will ever receive a pot");
  });

  // the fix's own checks (401fac3's follow-up)
  it("the ring and its legend name the escrow as what covers a defaulted seat", async () => {
    g.__wallet = { publicKey: null, sendTransaction: async () => "x" };
    const text = await render(shortDefault, { phase: "idle" }, null);
    assert.match(text, /settled in default: covered by the escrow its default prepaid/);
    assert.match(text, /◐ covered by the escrow its default prepaid/);
  });

  it("a Cancelled circle: no round ran, no pot is waited for, and no pot is called this round's", async () => {
    g.__wallet = { publicKey: null, sendTransaction: async () => "x" };
    const text = await render(cancelled, { phase: "idle" }, null);
    assert.match(text, /Rounds run None/);
    assert.match(text, /Did not run/);
    assert.match(text, /Pot None \(cancelled\)/);
    assert.doesNotMatch(text, /Pot this round/);
  });
});
