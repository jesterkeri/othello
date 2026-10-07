/**
 * A7 adversary, eighth pass: the shared single-circle page on a Solana circle (PR #27, 487fe28), against its spec.
 *
 *   Spec 2: "No step, tick, status line, banner or panel claims something the chain has not done or does not hold".
 *
 * a76dfd8 stopped the close-out panel promising a defaulted member the stock its default sold ("Your locked ... went
 * to cover missed payments"). The same page, in the same read, still tells that member in "Your next step" (the
 * member-tools row, LiveCircle.tsx `memberTools`): "The circle has ended: withdraw your stock, unused guarantee and
 * top-ups." declare_default sells min(stock_raw, what the seat owes) of the stock (declare_default.rs; its own unit
 * test "the_first_recipient_defaulting_at_round_one_sells_everything_and_the_reserve_takes_the_rest"), so a seat that
 * defaulted early holds stock_raw 0, which the page's own read carries (lockedRaw). The program holds no stock for
 * that seat to withdraw; the page contradicts its own close-out panel two blocks away.
 *
 * State: a Completed circle of 5, seat 3 (the connected wallet) defaulted, its stock all sold (lockedRaw 0), not yet
 * withdrawn. Same state as tests/a7-circle-page-safety-adversary.spec.ts case 3.
 *
 * Harness: tests/a7-circle-page-safety-adversary.spec.ts (LiveCircle rendered with react-dom/server, its useState and
 * useRef calls seeded, the wallet and the frame's wallet layer stubbed). No network.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-sold-stock-adversary.spec.ts     (installs hooks: its own process)
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
  // since 84686f9 each transaction on the page carries the wallet that sent it (`by`); a seed without one was sent
  // by the wallet connected here
  if (pay && typeof pay === "object" && (pay as { phase?: string }).phase !== "idle" && !("by" in pay)) {
    pay = { ...(pay as object), by: (g.__wallet as { publicKey: { toBase58(): string } }).publicKey.toBase58() };
  }
  // and the status of the read it was sent from (a finished outcome belongs to that state of the circle); a seed
  // without one was sent from the read shown
  if (pay && typeof pay === "object" && (pay as { phase?: string }).phase !== "idle" && !("status" in pay)) {
    pay = { ...(pay as object), status: view.status };
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
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, {}));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

const sentence = (text: string, re: RegExp) => {
  const at = text.search(re);
  return at < 0 ? "" : text.slice(Math.max(0, text.lastIndexOf(".", at - 2) + 1), text.indexOf(".", at) + 1).trim();
};

describe("A7 adversary: a defaulted seat whose stock was all sold, on a completed Solana circle", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[2]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

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

  it("\"Your next step\" does not tell that seat to withdraw its stock", async () => {
    const text = await render(done, { phase: "idle" }, null);
    assert.match(text, /Seat 3 \(you\)/, "precondition: the connected wallet is seat 3");
    assert.match(text, /went to cover missed payments/, "precondition: the close-out panel already says the stock is gone");
    assert.doesNotMatch(
      text,
      /withdraw your stock/i,
      `seat 3's stock_raw is 0 in the page's own read, yet the page says: "${sentence(text, /withdraw your stock/i)}"`,
    );
  });

  // the fix's own wording (487fe28's follow-up): the row says what the seat still holds, whatever words a later change picks
  it("\"Your next step\" says the stock went to cover missed payments, and promises no remaining stock", async () => {
    const text = await render(done, { phase: "idle" }, null);
    assert.match(text, /Your locked stock went to cover missed payments: withdraw whatever is left for your seat\./);
    assert.doesNotMatch(text, /remaining stock/i);
  });
});
