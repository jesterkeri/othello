/**
 * A7 adversary, fourth pass: the shared single-circle page on a Solana circle (PR #27, 84686f9), against its spec.
 *
 *   Spec 2: "every action's outcome (done, declined, refused, unconfirmed) shows in the round it applies to, with its
 *   transaction where one was sent, and nowhere after; an action in flight is always shown."
 *
 * Since fd9d764/74ce48b a release's progress lives only in the payout panel (LiveCircle.tsx `status` and `sig` are null
 * for any `what` starting "Release"), and the payout panel is drawn only while the circle is Active or the release has
 * been confirmed (`payout = active || shownRelease.kind === "released"`). The last round's release makes the circle
 * Completed (programs/othello/src/instructions/release_pot.rs: Completed, round not advanced). So while that release is
 * in flight, the first read that shows the circle Completed (the page re-reads every 5 s, independently of
 * confirmTransaction) removes the payout panel, and nothing on the page shows the transaction in flight: no
 * "Releasing...", no link, no status line. A connected wallet that is not a member also gets no close-out blocker
 * ("A transaction is already waiting..."), which only a member with a seat to collect sees.
 *
 * Sequence: round 5 of 5, every seat paid; a non-member wallet presses "Release pot to Nneka"; the wallet sends it
 * (pay = confirming, its signature); the 5 s refresh returns the read in which the release has landed (Completed,
 * round index 4, every seat received) before confirmTransaction resolves. Same with the release still in the wallet
 * while another member's release completes the circle.
 *
 * Harness: tests/a7-circle-page-stale-status-adversary.spec.ts (LiveCircle rendered with react-dom/server, its useState
 * and useRef calls seeded, the wallet and the frame's wallet layer stubbed).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-inflight-adversary.spec.ts     (installs hooks: its own process)
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

async function renderHtml(view: CircleView, pay: unknown, releasing: unknown): Promise<string> {
  // since 84686f9 each transaction on the page carries the wallet that sent it (`by`); a seed without one was sent
  // by the wallet connected here
  if (pay && typeof pay === "object" && (pay as { phase?: string }).phase !== "idle" && !("by" in pay)) {
    pay = { ...(pay as object), by: (g.__wallet as { publicKey: { toBase58(): string } }).publicKey.toBase58() };
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
  return renderToStaticMarkup(React.createElement(LiveCircle, {}));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const SIG = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const POT = BigInt(base.contribution) * BigInt(base.n);
// the read once the last round's release has landed: Completed, round index stays 4 (release_pot.rs), every seat received
const completed: CircleView = { ...base, status: "Completed", round: 4, paidBitmap: 0, receivedBitmap: 0b11111, defaultedBitmap: 0 };

describe("A7 adversary: a release in flight stays shown when the read turns Completed", () => {
  beforeEach(() => {
    g.__sets = [];
    // a wallet that is not a member: anyone may release a settled pot (SPEC §5)
    g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => "x" };
    g.__conn = {};
  });

  it("the last round's release, sent and not yet confirmed, is still shown once the read says Completed", async () => {
    const pay = { phase: "confirming", what: "Release pot to Nneka", sig: SIG, round: 4 };
    const releasing = { round: 4, turn: 4, amount: POT };
    const html = await renderHtml(completed, pay, releasing);
    const t = text(html);
    // precondition: the completed circle, seen by a wallet that is not a member
    assert.match(t, /All 5 rounds are paid out/);
    assert.match(t, /This wallet is not a member of this circle/);
    assert.ok(
      html.includes(SIG) || /Releasing|Confirming on devnet/.test(t),
      "a release sent from this page and still awaiting confirmation is shown nowhere: no status, no 'Releasing', no transaction link",
    );
  });

  it("the last round's release still waiting in the wallet is shown once the read says Completed", async () => {
    const pay = { phase: "wallet", what: "Release pot to Nneka", round: 4 };
    const releasing = { round: 4, turn: 4, amount: POT };
    const t = text(await renderHtml(completed, pay, releasing));
    assert.match(t, /All 5 rounds are paid out/);
    assert.match(t, /approve it in your wallet|Confirm in your wallet/, "a release waiting in the wallet is shown nowhere on the page");
  });
});

/**
 * Spec 5: "nothing read for an earlier address or wallet is drawn"; spec 2: no status line "claims something the chain
 * has not done". `pay` records the round an action was sent in but not the wallet that sent it, and nothing resets it
 * when the wallet changes. Seat 1 (Ada's wallet) pays round 1 ("Payment: done."); the visitor switches the wallet to
 * seat 2 (Tunde), who has not paid round 1: the page says Tunde's payment is due and, under it, "Payment: done.".
 */
describe("A7 adversary: an action's outcome stays with the wallet that sent it", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[1]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  it("seat 1's confirmed payment is not shown as done after the wallet switches to seat 2, who owes", async () => {
    // round 1 (index 0): only seat 1 has paid
    const round1: CircleView = { ...base, round: 0, paidBitmap: 0b00001, receivedBitmap: 0, defaultedBitmap: 0, roundDeadline: NOW + 600 };
    const t = text(await renderHtml(round1, { phase: "done", what: "Payment", sig: SIG, round: 0, by: wallets[0]! }, null));  // sent by seat 1's wallet
    // precondition: the connected wallet is seat 2 and owes round 1
    assert.match(t, /Seat 2: your 50 test USDC for round 1 is due\./);
    assert.doesNotMatch(t, /Payment: done\./, "the previous wallet's payment is shown as done under this wallet's due payment");
  });
});
