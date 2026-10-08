/**
 * Adversary on dbadb91 (the shared single-circle page, Solana side). The brief's spec item 2: "No step, tick, status
 * line, banner, chip, clock, ledger line, button label or panel claims something the chain has not done or does not
 * hold, in any circle status"; item 3: "Every figure ... in its own unit and decimals". dbadb91's own invariant:
 * "Solana amounts are shown to the cent, or to the base unit when they have more, so a shortfall is never rounded
 * down (a top-up of the figure shown would have left the round unfunded)".
 *
 *   1. A seat that joined with no stock (join_and_lock accepts stock_raw 0 when H(0) >= min_stock_cover, i.e.
 *      min_stock_cover 0, which create_circle does not forbid) and never defaulted: dbadb91 sets the close-out's
 *      lockedLeft to true for it, so the "Collect your share" panel tells it "You collect your locked NFLXx devnet
 *      mirror ..." while its Member.stock_raw is 0. The member row right below says, correctly, "withdraw whatever your
 *      seat still holds in the reserve".
 *   2. The "Payouts paused." banner and the "Anyone can move the circle on" text still name next_gate_short_by rounded
 *      to cents: a gate 1.234567 test USDC short reads "Top up 1.23 test USDC", and top_up_reserve of 1.23 leaves
 *      next_gate_short_by at 0.004567 (top_up_reserve.rs closed form), still Paused. The payout steps and the reserve
 *      ledger on the same page name 1.234567.
 *
 * Harness copied from tests/a7-circle-page-reserve-figures-adversary.spec.ts (LiveCircle rendered with
 * react-dom/server, its useState seeded). Fixtures are the repo's own CIRCLE_STATES.active with fields changed as each
 * case says.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-closeout-zero-stock-adversary.spec.ts   (own process)
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
};
const g = globalThis as G;

// LiveCircle's useState, in call order: live, error, pay, lockAmt, topAmt. Each is seeded from g.__seed.
const REACT_SHIM = `
import R from "${REACT_URL}";
export default R;
export const { useCallback, useEffect, useRef } = R;
export function useState(init) {
  const [v, set] = R.useState(init);
  const k = (globalThis.__n++) % 5;
  const seeded = globalThis.__seed && k in globalThis.__seed ? globalThis.__seed[k] : v;
  return [seeded, (x) => { globalThis.__sets.push(x); try { set(x); } catch {} }];
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
import { derive, needG, releaseBlock, seatSet, type CircleView } from "../app/src/lib/circle.ts";

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
const allPaid: CircleView = { ...base, round: 0, paidBitmap: 0b11111, receivedBitmap: 0, defaultedBitmap: 0, roundDeadline: NOW + 60 };

async function render(view: CircleView, props: Record<string, unknown> = {}): Promise<{ html: string; text: string; on: Record<string, boolean> }> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  g.React = React;
  g.__n = 0;
  g.__seed = [
    {
      view,
      accounts: { circle: "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q", usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
      split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
      pool: { discountBps: 2000, usdc: 1_000_000_000 },
      readAt: NOW,
    },
    null,
    { phase: "idle" },
  ];
  const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, props));
  const on: Record<string, boolean> = {};
  for (const m of html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) on[m[2]!.replace(/&#x27;/g, "'").trim()] = !/\sdisabled=/.test(m[1]!);
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), on };
}


const figure = (s: string) => Number(s.replace(/,/g, ""));

describe("A7 adversary on dbadb91: a zero-stock seat's close-out, and the paused top-up figure", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[1]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  // Seat 2 (turn 1, the connected wallet) joined with stock_raw 0 and never defaulted.
  const zeroStock = (status: "Completed" | "Cancelled"): CircleView => ({
    ...base,
    status,
    round: status === "Completed" ? 4 : 0,
    paidBitmap: 0,
    receivedBitmap: status === "Completed" ? 0b11111 : 0,
    defaultedBitmap: 0,
    withdrawnBitmap: 0,
    members: base.members.map((m) => (m.turn === 1 ? { ...m, lockedRaw: 0 } : m)),
  });

  for (const status of ["Completed", "Cancelled"] as const) {
    it(`${status}: a seat with no locked stock is not promised its locked stock in the close-out panel`, async () => {
      const view = zeroStock(status);
      assert.equal(view.members.find((m) => m.turn === 1)!.lockedRaw, 0, "precondition: seat 2 holds no stock");
      assert.ok(!seatSet(view.defaultedBitmap, 1), "precondition: seat 2 never defaulted");
      const { text } = await render(view);
      assert.match(text, /Seat 2 \(you\)/, "precondition: the connected wallet is seat 2");
      const claim = text.match(/You collect your locked [^.(]*/);
      assert.ok(!claim, `seat 2's Member.stock_raw is 0, yet the close-out panel says "${claim?.[0]}"`);
    });
  }

  // Round 2 (index 1), every seat paid, the last gate check found the reserve 1.234567 test USDC short.
  const shortBy = 1_234_567;
  const paused: CircleView = { ...base, round: 1, paidBitmap: 0b11111, receivedBitmap: 0b00001, defaultedBitmap: 0, roundDeadline: NOW + 60, nextGateShortBy: shortBy };

  it("Paused, 1.234567 short: the banner's top-up figure is not rounded down", async () => {
    assert.ok(derive(paused, NOW).paused, "precondition: the circle reads Paused");
    const { text } = await render(paused);
    assert.match(text, /Short of the payout gate, as last recorded 1\.234567 test USDC/, "precondition: the ledger names 1.234567");
    const shown = text.match(/Top up ([\d.,]+) test USDC, returned pro rata/);
    assert.ok(shown, "precondition: the Payouts paused banner names a top-up");
    assert.ok(Math.round(figure(shown[1]!) * 1e6) >= shortBy,
      `the banner says "${shown[0]}"; next_gate_short_by is 1.234567 test USDC, and a top-up of the figure shown leaves the circle Paused`);
  });

  it("Paused, 1.234567 short: the release text names the shortfall to the base unit", async () => {
    const { text } = await render(paused);
    const shown = text.match(/payouts were paused, ([\d.,]+) test USDC short/);
    assert.ok(shown, "precondition: the anyone-may-send text names the shortfall");
    assert.equal(Math.round(figure(shown[1]!) * 1e6), shortBy, `the release text says "${shown[0]}"; the stored shortfall is 1.234567`);
  });

  // the fix's own checks (dbadb91's follow-up)
  it("a seat with no stock: the close-out names what it does collect, in both finished states", async () => {
    assert.match((await render(zeroStock("Completed"))).text, /You collect whatever share of the shared reserve your seat still has; your seat locked no stock\./);
    assert.match((await render(zeroStock("Cancelled"))).text, /You collect your guarantee and top ups; your seat locked no stock\./);
  });

  it("Paused, 1.234567 short: the banner and the release text name the shortfall to the base unit", async () => {
    const { text } = await render(paused);
    assert.match(text, /Top up 1\.234567 test USDC/);
    assert.match(text, /payouts were paused, 1\.234567 test USDC short/);
  });
});
