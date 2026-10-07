/**
 * Adversary on b28e8d2 (the shared single-circle page, Solana side). SPEC.md is authoritative; the brief's spec
 * item 2: "No step, tick, status line, banner, chip, clock or panel claims something the chain has not done or does
 * not hold, in any circle status"; item 3: "Every figure ... in its own unit and decimals".
 *
 *   1. Escrow short (SPEC.md:109 release_pot: escrow >= k x c, else round_not_funded; SPEC.md:228 "Round not funded:
 *      escrow short"): the payout panel ticks Payments done ("Every seat is in") and the banner promises a release
 *      once the last owing seat pays, while release_pot refuses the round.
 *   2. A contribution with cents: the pay button rounds it to whole test USDC.
 *   3. A cancelled circle's seat page says the seat "Receives the pot in round N"; cancel_circle runs only while
 *      Forming, so no round ever runs.
 *
 * Harness copied from tests/a7-circle-page.spec.ts (LiveCircle rendered with react-dom/server, its useState seeded).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-escrow-short-adversary.spec.ts   (own process)
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
import { releaseBlock, type CircleView } from "../app/src/lib/circle.ts";

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

/** The class of the payout panel's step whose label is `label` (the CSS proxy turns class names into their keys). */
function stepClass(html: string, label: string): string | null {
  for (const m of html.matchAll(/<li class="step ([a-z]+)">(.*?)<\/li>/g)) if (m[2]!.includes(`<b>${label}</b>`)) return m[1]!;
  return null;
}

describe("A7 adversary on b28e8d2: claims the chain does not hold", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[1]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  // Round 3 (index 2). Seat 1 (turn 0) took round 1's pot and was declared in default; the reserve could not cover all
  // of its prepaid payments, so the escrow is empty with a deficit (SPEC.md section 6). Seat 2 has received too.
  const shortEscrow: CircleView = {
    ...base,
    round: 2,
    receivedBitmap: 0b00011,
    defaultedBitmap: 0b00001,
    paidBitmap: 0b11110,
    escrow: 0,
    escrowDeficit: 50_000_000,
    roundDeadline: NOW + 60,
  };

  it("escrow short, every other seat paid: the Payments step is not ticked done while release_pot refuses the round", async () => {
    assert.equal(releaseBlock(shortEscrow, NOW), "escrow-short", "precondition: the program refuses (round_not_funded)");
    const { html, on } = await render(shortEscrow);
    const label = Object.keys(on).find((k) => k.startsWith("Release pot"));
    assert.ok(label, "precondition: the payout panel is drawn");
    assert.equal(on[label], false, "precondition: the page itself keeps the release disabled");
    assert.notEqual(stepClass(html, "Payments"), "done", `Payments is ticked done ("${html.match(/<b>Payments<\/b><span>([^<]*)/)?.[1]}") although release_pot refuses the round as not funded`);
  });

  it("escrow short, one seat still owes: the banner does not promise a release once it pays", async () => {
    // Seat 3 (turn 2) has not paid yet; Seat 1 is in default with nothing in the escrow for its share
    const oneOwes: CircleView = { ...shortEscrow, paidBitmap: 0b11010 };
    const { text } = await render(oneOwes);
    assert.match(text, /1 contribution still missing/, "precondition: the banner is drawn");
    assert.doesNotMatch(text, /Once \S+ has paid, anyone can release the pot/, `the banner promises a release the program refuses: "${text.match(/Once [^.]*\./)?.[0]}"`);
  });

  it("a contribution with cents: the pay button names the amount contribute takes", async () => {
    const cents: CircleView = { ...allPaid, contribution: 10_400_000, paidBitmap: 0b11101 };
    const { on } = await render(cents);
    const label = Object.keys(on).find((k) => /^Pay [\d.,]+ test USDC$/.test(k));
    assert.ok(label, `no pay button: ${Object.keys(on).join(" | ")}`);
    assert.equal(Number(label.match(/^Pay ([\d.,]+)/)![1]!.replace(/,/g, "")), 10.4, `the button says "${label}"; contribute takes 10.40 test USDC`);
  });

  it("a cancelled circle's seat page does not say the seat receives a pot", async () => {
    const cancelled: CircleView = { ...base, status: "Cancelled", round: 0, paidBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0, joinedBitmap: 0b00011 };
    const { text } = await render(cancelled, { seat: 2, kind: "position" });
    assert.match(text, /Seat 2: /, "precondition: the seat is in focus");
    assert.doesNotMatch(text, /Receives the pot in round/, `no round runs in a cancelled circle: "${text.match(/Locked [^]*?Receives the pot in round \d+\./)?.[0]}"`);
  });

  // the fix's own checks (b28e8d2's follow-up)
  it("escrow short: the Payments step and the banner name the shortfall and the top-up that funds it", async () => {
    const { text } = await render(shortEscrow);
    assert.match(text, /Every seat is in for round 3, but the escrow is 50\.00 test USDC short of the defaulted seats' share: a reserve top-up funds it/);
    const owes = await render({ ...shortEscrow, paidBitmap: 0b11010 });
    assert.match(owes.text, /and a reserve top-up funds the 50\.00 test USDC the escrow lacks of the defaulted seats' share, anyone can release the pot/);
    assert.match(owes.text, /\. The escrow is also 50\.00 test USDC short of the defaulted seats' share/);
  });

  it("the exact amount: whole contributions without decimals, cents with two", async () => {
    const whole = await render({ ...allPaid, paidBitmap: 0b11101 });
    assert.ok(Object.keys(whole.on).includes("Pay 50 test USDC"), Object.keys(whole.on).join(" | "));
    const cents = await render({ ...allPaid, contribution: 10_400_000, paidBitmap: 0b11101 });
    assert.ok(Object.keys(cents.on).includes("Pay 10.40 test USDC"), Object.keys(cents.on).join(" | "));
    assert.match(cents.text, /your 10\.40 test USDC for round/);
  });

  it("a cancelled circle's seat page says no round ran", async () => {
    const cancelled: CircleView = { ...base, status: "Cancelled", round: 0, paidBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0, joinedBitmap: 0b00011 };
    const { text } = await render(cancelled, { seat: 2, kind: "position" });
    assert.match(text, /The circle was cancelled before any round ran\./);
  });
});
