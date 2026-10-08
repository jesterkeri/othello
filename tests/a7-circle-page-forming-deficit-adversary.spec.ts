/**
 * A7 adversary, tenth pass: the shared single-circle page on a Solana circle (PR #27, cda5631), against its spec.
 *
 *   Spec 2: "No step, tick, status line, banner, chip or panel claims something the chain has not done or does not
 *   hold".
 *
 * Case 1: a Forming circle on a mint that is repricing. cda5631 words the Solana panel's "Price and split" row from
 * `c.status === "Active"` only: any other status reads "Disagree (the circle has ended, so nothing waits on it)".
 * Forming is not ended, and something does wait on the price: join_and_lock (join_and_lock.rs, value_position) refuses
 * a feed stamped for another multiplier (SPEC.md I13: "release_pot, update_coverage, join_and_lock refuse"). The same
 * commit also took the Repricing pill and banner off every non-Active circle, so on a Forming circle nothing on the
 * page says joins wait, and one row says the circle has ended. The feed is one per mint (seeds ["price", stock_mint]),
 * so a circle still forming when the mint's split lands is in exactly this state.
 *
 * State: CIRCLE_STATES.forming (the repo's fixture), with the mint's multiplier taken from CIRCLE_STATES.repricing
 * (x10 while the feed is stamped for x1). Price fresh.
 *
 * Case 2: a defaulted seat whose default the reserve could not fully absorb. cda5631's "Your next step" title says
 * "Declaring the default prepaid its remaining payments: its stock was sold, and the shared reserve paid any
 * shortfall." SPEC.md section 6: loss = min(shortfall, reserve_total - reserve_losses); escrow_deficit += shortfall -
 * loss, "cured by top_up_reserve". When escrow_deficit > 0 the reserve did not pay the shortfall and the remaining
 * payments are not prepaid: release_pot refuses round_not_funded once the escrow runs short (SPEC.md:228's
 * "{name}'s prepaid contributions ran {deficit} USDC short").
 * State: the demo circle (SPEC.md:134) after its stock fell to 25 USDC a token. Seat 1 paid round 1, received the pot,
 * missed round 2 and was declared in default. SPEC section 6 with the program's own figures (declare_default.rs
 * `demo`): O = 50 x 4 = 200; conservative = 25 x 0.8 = 20; sell_raw = min(1.1 token, ceil(200 / 20) = 10 tokens) =
 * 1.1 token; recovered = 22; shortfall = 178; loss = min(178, 175) = 175; escrow = 22 + 175 = 197; escrow_deficit = 3.
 * (declare_default.rs `what_the_reserve_cannot_absorb_becomes_an_escrow_deficit` is the same branch with 18 short.)
 *
 * Harness: tests/a7-circle-page-repricing-finished-adversary.spec.ts (LiveCircle rendered with react-dom/server, its
 * useState and useRef calls seeded, the wallet and the frame's wallet layer stubbed). No network.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-forming-deficit-adversary.spec.ts     (installs hooks: its own process)
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
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, props));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

const USDC = 1_000_000;

describe("A7 adversary: a Forming circle is not ended; a deficit is not prepaid", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__conn = {};
  });

  // a Forming circle on the same mint, read after the multiplier moved and before the shared feed was re-priced
  const formingAfterSplit: CircleView = {
    ...CIRCLE_STATES.forming,
    members: CIRCLE_STATES.forming.members.map((m, i) => ({ ...m, address: wallets[i]! })),
    feed: { ...CIRCLE_STATES.forming.feed, updatedAt: NOW - 30 },
    effectiveMultiplier: CIRCLE_STATES.repricing.effectiveMultiplier,
  };

  it("a Forming circle whose joins wait on the price is not told it has ended", async () => {
    g.__wallet = { publicKey: null, sendTransaction: async () => "x" };
    const text = await render(formingAfterSplit, { phase: "idle" }, null);
    assert.match(text, /Waiting for 3 members to join/, "precondition: the page shows the circle forming");
    assert.doesNotMatch(
      text,
      /the circle has ended/,
      "the chain holds Forming, and join_and_lock refuses a feed priced for another multiplier (SPEC.md I13)",
    );
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

  it("a defaulted seat with an escrow deficit is not told the reserve paid its shortfall", async () => {
    assert.equal(recovered, 22 * USDC, "precondition: SPEC section 6's figures");
    assert.equal(deficit, 3 * USDC, "precondition: the reserve could not absorb 3 USDC of the shortfall");
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[0]!), sendTransaction: async () => "x" };
    const text = await render(shortDefault, { phase: "idle" }, null);
    assert.match(text, /This seat has defaulted/, "precondition: the connected wallet is the defaulted seat");
    assert.doesNotMatch(
      text,
      /the shared reserve paid any shortfall/,
      "escrow_deficit is 3 USDC: the reserve paid 175 of the 178 short, and a top-up must cure the rest (SPEC section 6)",
    );
  });

  // the fix's own checks (cda5631's follow-up)
  it("a Forming circle after the split: Repricing, joins wait (banner, panel row, and a not-yet-joined seat's page)", async () => {
    g.__wallet = { publicKey: null, sendTransaction: async () => "x" };
    const text = await render(formingAfterSplit, { phase: "idle" }, null);
    assert.match(text, /Repricing/);
    assert.match(text, /Joins wait\. The demo admin sets a price for the new multiplier, then seats can join\./);
    assert.match(text, /Disagree \(repricing\): joins wait for a price set for the new split/);
    assert.doesNotMatch(text, /payouts wait/i, "a Forming circle has no payout to hold");
    const seat = await render(formingAfterSplit, { phase: "idle" }, null, { seat: 5, kind: "join" });
    assert.match(seat, /This seat has not joined yet/, "precondition: seat 5 has not joined");
    assert.match(seat, /Joining waits until the price is set for the new multiplier\./);
  });

  it("a defaulted seat with an escrow deficit is told the escrow's shortfall and its cure, in test USDC", async () => {
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[0]!), sendTransaction: async () => "x" };
    const text = await render(shortDefault, { phase: "idle" }, null);
    assert.match(text, /the circle's escrow is still 3\.00 test USDC short of the prepaid payments; a reserve top-up cures it\./);
  });
});
