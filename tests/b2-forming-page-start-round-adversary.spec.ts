/**
 * B2 adversary on 6587a2b: a done Start stays shown in every later round of the circle it started.
 *
 *   Spec 4 (PR 2 brief): "every outcome shows only to the wallet that sent it, in the round and circle state it applies
 *   to (except that a done Start or Cancel stays shown in the Active or Cancelled state it caused), with its
 *   transaction, and nowhere after".
 *
 * The exception relaxes the circle STATE (Forming to Active), not the ROUND. LiveCircle.tsx `caused` is true for a done
 * Start whenever the read says Active, and `stale` is then forced false, so the round check (pay.round !== c.round) is
 * skipped too: round 3's page still reads "Start the circle: done." with the Start's transaction, under round 3's
 * payment due (the same defect a76dfd8 fixed for a payment).
 *
 * Harness: tests/b2-forming-page.spec.ts (react-dom/server, LiveCircle's state seeded in call order).
 *
 *   npx mocha --import=tsx --timeout 600000 tests/b2-forming-page-start-round-adversary.spec.ts     (installs hooks: its own process)
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
    // the frame (Shell) picks its side from the connected wallets (lib/active-side.ts, since A2): stub that layer as
    // this test stubs the wallet control, so the page renders without the app's wallet providers
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
import { minJoinStock, type CircleView } from "../app/src/lib/circle.ts";
import { joinReadiness } from "../app/src/lib/solana-join.ts";

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

async function buttons(view: CircleView, props: Record<string, unknown> = {}, pay: unknown = { phase: "idle" }, pool = { discountBps: 2000, usdc: 1_000_000_000 }): Promise<{ text: string; on: Record<string, boolean> }> {
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
    pay,
  ];
  const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle, props));
  const on: Record<string, boolean> = {};
  for (const m of html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) on[m[2]!.replace(/&#x27;/g, "'").trim()] = !/\sdisabled=/.test(m[1]!);
  return { text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), on };
}


// A forming circle: seat 1 (the creator) has joined; seats 2 to 5 have not.
const forming: CircleView = { ...base, creator: wallets[0]!, status: "Forming", round: 0, paidBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0, joinedBitmap: 0b00001 };
const full: CircleView = { ...forming, joinedBitmap: 0b11111 };
const as = (i: number) => {
  g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[i]!), sendTransaction: async () => "x" };
};
const SIG = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const WORDS = { stock: "NFLXx devnet mirror", usdc: (b: bigint) => `${(Number(b) / 1e6).toFixed(2)} test USDC` };

describe("B2 adversary: a done Start belongs to the round it opened", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__conn = { getAccountInfo: async () => null };
    as(0);
  });

  const startDone = { phase: "done", what: "Start the circle", sig: SIG, round: 0, status: "Forming", by: wallets[0]! };
  // what the read says once round 1 (index 0) has been released and round 3 (index 2) is open: nobody has paid it yet
  const laterRound: CircleView = { ...full, status: "Active", round: 2, paidBitmap: 0, receivedBitmap: 0b00011, roundDeadline: NOW + 120 };

  it("control: in the round the Start opened (Active, round 1) its outcome is shown", async () => {
    const opened = await buttons({ ...full, status: "Active", round: 0, roundDeadline: NOW + 120 }, {}, startDone);
    assert.match(opened.text, /Start the circle: done\./);
  });

  it("control: a done payment from round 1 is not shown in round 3", async () => {
    const paid = await buttons(laterRound, {}, { phase: "done", what: "Payment", sig: SIG, round: 0, status: "Active", by: wallets[0]! });
    assert.doesNotMatch(paid.text, /Payment: done\./);
  });

  it("in round 3 the Start's outcome and its transaction are no longer shown", async () => {
    const later = await buttons(laterRound, {}, startDone);
    assert.match(later.text, /for round 3 is due/);
    assert.doesNotMatch(later.text, /Start the circle: done\./);
  });
});
