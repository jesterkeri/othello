/**
 * Adversary on 5a46c40 (the shared single-circle page, Solana side). SPEC.md is authoritative; the brief's spec
 * item 2: "No step, tick, status line, banner, chip, clock, button label or panel claims something the chain has not
 * done or does not hold, in any circle status"; item 3: "Every figure ... in its own unit and decimals".
 *
 *   1. The reserve panel's "Next payout needs" line is remains + next_gate_short_by. When the gate passes
 *      (next_gate_short_by = 0) that is just what remains, not what release_pot's gate needs (SPEC.md:126, the sum of
 *      need_i over received, non-defaulted seats, the recipient counted as received). The demo fixture's round 2 gate
 *      needs 126 test USDC (63 for Ada, 63 for Tunde, as the fixture's own comments work out); the page says 175. On a
 *      completed circle there is no next payout at all, and the line still names one.
 *   2. The escrow shortfall named in the payout steps and the banner (new in 5a46c40) is rounded to cents, down: an
 *      escrow 1.234567 test USDC short reads "1.23 short", and a top-up of that leaves release_pot refusing the round
 *      (round_not_funded) for the rest.
 *
 * Harness copied from tests/a7-circle-page-escrow-short-adversary.spec.ts (LiveCircle rendered with react-dom/server,
 * its useState seeded). Fixtures are the repo's own CIRCLE_STATES.active with fields changed as each case says.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-reserve-figures-adversary.spec.ts   (own process)
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

describe("A7 adversary on 5a46c40: money figures the chain does not hold", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[1]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  // The demo fixture as it is: round 2 (index 1), Tunde's turn, Ada received in round 1, the gate passed at the last
  // check (next_gate_short_by 0), 175 test USDC remains.
  const running: CircleView = { ...base, roundDeadline: NOW + 60 };

  it("a running circle: 'Next payout needs' names what release_pot's gate needs, not what remains", async () => {
    // release_pot's gate (SPEC.md:126): needed = sum of need_i over non-defaulted seats that have received, the
    // recipient counted as received. needG is need_i = max(0, ceil(O_i x coverage_bps / 10000) - H_i).
    const asReceived: CircleView = { ...running, receivedBitmap: running.receivedBitmap | (1 << running.round) };
    const needed = asReceived.members
      .filter((m) => seatSet(asReceived.receivedBitmap, m.turn) && !seatSet(asReceived.defaultedBitmap, m.turn))
      .reduce((sum, m) => sum + needG(asReceived, m), 0);
    assert.equal(needed, 126_000_000, "precondition: the gate needs 126 test USDC (63 + 63, the fixture's own figures)");
    assert.equal(derive(running, NOW).remains, 175_000_000, "precondition: 175 test USDC remains");
    assert.equal(running.nextGateShortBy, 0, "precondition: the last check passed");

    const { text } = await render(running);
    const shown = text.match(/Next payout needs ([\d.,]+) test USDC/);
    if (shown) assert.equal(figure(shown[1]!), needed / 1e6, `the reserve panel says "${shown[0]}"; the next payout's gate needs 126.00 test USDC`);
  });

  it("a completed circle: the reserve panel names no next payout", async () => {
    const completed: CircleView = { ...base, status: "Completed", round: 4, paidBitmap: 0, receivedBitmap: 0b11111, nextGateShortBy: 0 };
    const { text } = await render(completed);
    assert.match(text, /All 5 rounds paid out/, "precondition: the circle reads Completed");
    const shown = text.match(/Next payout needs ([\d.,]+) test USDC/);
    assert.ok(!shown || figure(shown[1]!) === 0, `every round is paid out, yet the reserve panel says "${shown?.[0]}"`);
  });

  // Round 3 (index 2). Seat 1 (turn 0) took round 1's pot and was declared in default; the escrow holds less than its
  // share of this round by 1.234567 test USDC (the rest of its prepaid rounds is the escrow deficit, SPEC.md section 6).
  const short = 1_234_567;
  const shortEscrow: CircleView = {
    ...base,
    round: 2,
    receivedBitmap: 0b00011,
    defaultedBitmap: 0b00001,
    paidBitmap: 0b11110,
    escrow: 50_000_000 - short,
    escrowDeficit: 150_000_000 - (50_000_000 - short),
    roundDeadline: NOW + 60,
  };

  it("escrow short by 1.234567: the payout steps name the shortfall to the base unit, not rounded down", async () => {
    assert.equal(releaseBlock(shortEscrow, NOW), "escrow-short", "precondition: release_pot refuses (round_not_funded)");
    const { text } = await render(shortEscrow);
    const shown = text.match(/the escrow is ([\d.,]+) test USDC short/);
    assert.ok(shown, "precondition: the Payments step names the shortfall");
    assert.equal(Math.round(figure(shown[1]!) * 1e6), short, `the Payments step says "${shown[0]}"; the escrow lacks 1.234567 test USDC, and a top-up of the figure shown leaves the round unfunded`);
  });

  it("escrow short by 0.000001, a seat still owes: the banner does not name a 0.00 shortfall", async () => {
    const tiny: CircleView = { ...shortEscrow, paidBitmap: 0b11010, escrow: 49_999_999, escrowDeficit: 100_000_001 };
    const { text } = await render(tiny);
    const shown = text.match(/a reserve top-up funds the ([\d.,]+) test USDC the escrow lacks/);
    assert.ok(shown, "precondition: the banner names the shortfall");
    assert.notEqual(figure(shown[1]!), 0, `the banner says "${shown[0]}" while release_pot refuses the round as not funded`);
  });

  // the fix's own checks (5a46c40's follow-up)
  it("the ledger shows the last gate check's stored figure while a payout is to come, and nothing after", async () => {
    const run = await render(running);
    assert.match(run.text, /Short of the payout gate, last check 0\.00 test USDC/);
    const never = await render({ ...running, lastCoverageAt: 0 });
    assert.match(never.text, /Short of the payout gate, last check Not checked yet/);
    const done = await render({ ...base, status: "Completed", round: 4, paidBitmap: 0, receivedBitmap: 0b11111, nextGateShortBy: 0 });
    assert.doesNotMatch(done.text, /payout gate, last check|Next payout needs/);
  });

  it("the shortfall is named to the base unit: 1.234567 and 0.000001", async () => {
    assert.match((await render(shortEscrow)).text, /the escrow is 1\.234567 test USDC short/);
    const tiny: CircleView = { ...shortEscrow, paidBitmap: 0b11010, escrow: 49_999_999, escrowDeficit: 100_000_001 };
    assert.match((await render(tiny)).text, /a reserve top-up funds the 0\.000001 test USDC the escrow lacks/);
  });

  it("a member who joined with no stock and never defaulted is not told their stock covered missed payments", async () => {
    const zero: CircleView = { ...base, status: "Completed", round: 4, paidBitmap: 0, receivedBitmap: 0b11111, withdrawnBitmap: 0,
      members: base.members.map((m) => (m.turn === 1 ? { ...m, lockedRaw: 0 } : m)) };
    const { text } = await render(zero);
    assert.match(text, /Seat 2 \(you\)/, "precondition: the connected wallet is seat 2");
    assert.doesNotMatch(text, /went to cover missed payments/);
    assert.match(text, /The circle has ended: withdraw whatever your seat still holds in the reserve\./);
  });
});
