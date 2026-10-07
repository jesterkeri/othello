/**
 * A7 adversary, twelfth pass: the shared single-circle page on a Solana circle (PR #27, af399a9), against its spec.
 *
 *   Spec 2: "No step, tick, status line, banner, chip, clock or panel claims something the chain has not done or does
 *   not hold, in any circle status (Forming, Active, Completed, Cancelled)".
 *
 * Both cases are a circle in a round after a seat was declared in default. The default stays on the seat for every
 * later round (defaulted_bitmap is never cleared), contribute refuses a defaulted seat (programs/othello/src/
 * instructions/contribute.rs:73), and release_pot pays that seat's share from the escrow its default prepaid
 * (release_pot.rs:308, SPEC.md section 5). lib/circle.ts missingContributions counts unpaid seats, defaulted or not.
 *
 * Case 1: every other seat has paid. The program will release now (lib/circle.ts releaseBlock is null; the payout
 * panel's button is enabled and "Anyone can move the circle on" says anyone can release), yet the banner says
 * "1 contributions still missing ... Once everyone has paid, anyone can release the pot": a payment the defaulted seat
 * can never send.
 *
 * Case 2: only this round's recipient has paid. The payout panel's Payments step counts the defaulted seat as paid
 * ("2 of 5 paid"), while the chain's paid_bitmap holds one payment; payoutSteps' own comment says a seat settled in
 * default "has not 'paid'".
 *
 * State: the demo circle (CIRCLE_STATES.active, SPEC.md:134). Seat 1 received round 1's pot, missed round 2 and was
 * declared in default after its grace. SPEC.md section 6 at the fixture's 150 USDC price: O = 50 x 4 = 200, all 1.1
 * token sold for 132, the reserve paid the other 68 (loss), escrow = 200 with no deficit; round 2's release spent 50 of
 * it, so escrow = 150 in round 3.
 *
 * Harness: tests/a7-circle-page-ring-default-adversary.spec.ts (LiveCircle rendered with react-dom/server, its
 * useState and useRef calls seeded, the wallet and the frame's wallet layer stubbed). No network.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-default-count-adversary.spec.ts     (installs hooks: its own process)
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

async function render(view: CircleView): Promise<{ html: string; text: string }> {
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
    { phase: "idle" },
  ];
  g.__refs = [1, null];
  const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, {}));
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ") };
}

const USDC = 1_000_000;

describe("A7 adversary: a seat in default is neither a missing payment nor a paid one", () => {
  // SPEC section 6 by hand, on the demo circle's parameters and the fixture's 150 USDC price, default in round 2
  const O = 50 * USDC * 4;
  const conservative = (A.feed.wrapperPrice * (10_000 - A.haircutBps)) / 10_000;
  const sellRaw = Math.min(A.members[0]!.lockedRaw, Math.ceil((O * 1e8) / conservative));
  const recovered = Math.floor((sellRaw * conservative) / 1e8);
  const loss = Math.min(O - Math.min(O, recovered), A.reserveTotal);
  const deficit = O - Math.min(O, recovered) - loss;

  // round 3 (index 2): seat 1 defaulted in round 2, seat 2 received round 2's pot, seat 3 receives now
  const afterDefault = (paidBitmap: number): CircleView => ({
    ...base,
    round: 2,
    paidBitmap,
    receivedBitmap: 0b00011,
    defaultedBitmap: 0b00001,
    reserveAllocated: 0,
    reserveLosses: loss,
    escrow: Math.min(O, recovered) + loss - 50 * USDC,
    escrowDeficit: 0,
    roundDeadline: NOW + 100,
    members: base.members.map((m) => (m.turn === 0 ? { ...m, lockedRaw: m.lockedRaw - sellRaw, roundsPaid: 1, allocated: 0 } : m)),
  });

  beforeEach(() => {
    g.__sets = [];
    g.__conn = {};
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[2]!), sendTransaction: async () => "x" };
  });

  it("every other seat has paid: no banner says the release waits for everyone to pay", async () => {
    assert.equal(recovered, 132 * USDC, "precondition: all 1.1 token sold for 132 of the 200 owed");
    assert.equal(loss, 68 * USDC, "precondition: the reserve paid the other 68");
    assert.equal(deficit, 0, "precondition: the escrow is whole (no deficit)");
    const { html, text } = await render(afterDefault(0b11110));
    assert.match(
      text,
      /Every other seat has paid, and Ada is covered by the default: anyone can release the pot/,
      "precondition: the page itself says the pot can be released now",
    );
    assert.match(html, /<button type="button" class="release">Release pot to [^<]+<\/button>/, "precondition: the release button is enabled");
    assert.doesNotMatch(
      text,
      /Once everyone has paid[^.]*anyone can release the pot/,
      "seat 1 is in default: contribute refuses it (contribute.rs:73) and release_pot pays its share from the escrow, so the release waits for no payment",
    );
  });

  it("only the recipient has paid: the Payments step does not count the defaulted seat as paid", async () => {
    const { text } = await render(afterDefault(0b00100));
    assert.match(text, /Payments [0-9] of 5 paid(, [0-9] settled in default)?; waiting for Seat 2, Seat 4 and Seat 5/, "precondition: the payout panel's Payments step is drawn");
    assert.doesNotMatch(
      text,
      /Payments 2 of 5 paid/,
      "paid_bitmap holds one payment (seat 3's); seat 1 was settled in default and has not paid",
    );
  });

  // the fix's own checks (af399a9's follow-up)
  it("only the recipient has paid: the banner waits for the 3 seats that can pay, and the step says 1 paid, 1 settled", async () => {
    const { text } = await render(afterDefault(0b00100));
    assert.match(text, /3 contributions still missing Once 3 seats have paid/);
    assert.match(text, /Payments 1 of 5 paid, 1 settled in default; waiting for Seat 2, Seat 4 and Seat 5/);
  });

  it("every seat that can pay has paid: no 'still missing' banner of any count", async () => {
    const { text } = await render(afterDefault(0b11110));
    assert.doesNotMatch(text, /still missing/);
  });
});
