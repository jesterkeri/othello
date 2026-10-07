/**
 * A7 adversary, ninth pass: the shared single-circle page on a Solana circle (PR #27, 3f0dc00), against its spec.
 *
 *   Spec 2: "No step, tick, status line, banner or panel claims something the chain has not done or does not hold".
 *
 * Case 1 (the worst): a finished circle after the stock's split. isRepricing (lib/circle.ts) and the page's status pill
 * and "Repricing" banner (LiveCircle.tsx `status=`, `banners`) do not look at the circle's status. Once the NFLXx mirror's
 * multiplier moves (the demo replays the real 10-for-1, SPEC §9b.1) and the shared price feed (seeds ["price",
 * stock_mint], one per mint, SPEC.md) is still stamped for x1, every Completed circle on that mint reads "Repricing"
 * instead of Completed, with the banner "Payouts wait. ... then anyone can update coverage." The chain holds Completed:
 * all n pots are paid (release_pot.rs sets Completed once n payouts are counted), and update_coverage refuses anything
 * but Active (update_coverage.rs: require!(status == Active, CircleNotActive)). The page's own close-out panel two
 * blocks down says "All 5 rounds are paid out".
 *
 * State: CIRCLE_STATES.completed (the repo's fixture, SPEC.md:134's demo parameters), with the mint's multiplier taken
 * from CIRCLE_STATES.repricing (x10 while the feed is stamped for x1). Price fresh. Connected wallet: seat 3.
 *
 * Case 2: a defaulted seat whose stock was sold in full and the reserve took the rest. Its member's own "Your next step"
 * title reads "Its remaining payments were covered from its stock." The state is the program's own unit test
 * declare_default.rs `the_first_recipient_defaulting_at_round_one_sells_everything_and_the_reserve_takes_the_rest`:
 * O = 200 USDC, all 1.1 token sold for 132, shortfall 68 taken by the reserve (loss 68), so the read carries
 * lockedRaw 0, reserveLosses 68 and escrow 132 + 68 = 200.
 *
 * Harness: tests/a7-circle-page-sold-stock-adversary.spec.ts (LiveCircle rendered with react-dom/server, its useState
 * and useRef calls seeded, the wallet and the frame's wallet layer stubbed). No network.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-repricing-finished-adversary.spec.ts     (installs hooks: its own process)
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

const USDC = 1_000_000;

describe("A7 adversary: claims the chain does not hold, on a Solana circle", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__conn = {};
  });

  // a Completed circle, read after the mint's multiplier moved and before the shared feed was re-priced
  const finishedAfterSplit: CircleView = {
    ...CIRCLE_STATES.completed,
    members: CIRCLE_STATES.completed.members.map((m, i) => ({ ...m, address: wallets[i]! })),
    feed: { ...CIRCLE_STATES.completed.feed, updatedAt: NOW - 30 },
    effectiveMultiplier: CIRCLE_STATES.repricing.effectiveMultiplier,
  };

  it("a finished circle is not called Repricing, and is not told its payouts wait", async () => {
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[2]!), sendTransaction: async () => "x" };
    const text = await render(finishedAfterSplit, { phase: "idle" }, null);
    assert.match(text, /All 5 rounds are paid out/, "precondition: the close-out panel shows the circle finished");
    assert.doesNotMatch(
      text,
      /Payouts wait/,
      "a Completed circle has paid every pot (release_pot.rs), yet the page's banner says payouts wait",
    );
    assert.doesNotMatch(
      text,
      /anyone can update coverage/,
      "update_coverage refuses a circle that is not Active (update_coverage.rs CircleNotActive)",
    );
    assert.doesNotMatch(text, /Repricing/, "the status the chain holds is Completed");
  });

  // declare_default.rs unit test state: seat 1 paid round 1, received, missed round 2; all stock sold, reserve took 68
  const soldOut: CircleView = {
    ...base,
    round: 1,
    paidBitmap: 0b11110,
    receivedBitmap: 0b00001,
    defaultedBitmap: 0b00001,
    reserveLosses: 68 * USDC,
    escrow: 200 * USDC,
    escrowDeficit: 0,
    roundDeadline: NOW + 60,
    members: base.members.map((m) => (m.turn === 0 ? { ...m, lockedRaw: 0, roundsPaid: 1, allocated: 0 } : m)),
  };

  it("a defaulted seat whose stock covered only part is not told its payments were covered from its stock", async () => {
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[0]!), sendTransaction: async () => "x" };
    const text = await render(soldOut, { phase: "idle" }, null);
    assert.match(text, /This seat has defaulted/, "precondition: the connected wallet is the defaulted seat");
    assert.doesNotMatch(
      text,
      /remaining payments were covered from its stock/,
      "132 of the 200 came from the stock, 68 from the shared reserve (reserveLosses 68 in the page's own read)",
    );
  });

  // the fix's own checks (3f0dc00's follow-up)
  it("a finished circle after the split: no payout waits anywhere, and its cover figures stay not countable", async () => {
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[2]!), sendTransaction: async () => "x" };
    const text = await render(finishedAfterSplit, { phase: "idle" }, null);
    assert.doesNotMatch(text, /payouts wait/i, "the Solana panel's price-and-split row too");
    assert.match(text, /Disagree \(the circle has ended, so nothing waits on it\)/);
    // the price is still set for the old multiplier: a cover figure from it would be ten times off
    assert.match(text, /Not countable/);
    assert.match(text, /Completed/);
  });

  it("a defaulted seat: told its payments were prepaid by the default, its Owed chip says Prepaid", async () => {
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[0]!), sendTransaction: async () => "x" };
    const text = await render(soldOut, { phase: "idle" }, null);
    assert.match(text, /Declaring the default prepaid its remaining payments: its stock was sold, and the shared reserve paid any shortfall\./);
    assert.match(text, /Owed Prepaid/, "SPEC.md: a defaulted seat's obligations are prepaid");
  });
});
