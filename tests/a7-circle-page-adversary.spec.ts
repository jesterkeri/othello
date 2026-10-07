/**
 * A7 adversary: the shared single-circle page, against its spec (PR #27, fd9d764).
 *
 *   Spec 2: "a failed or declined release is shown as such; a failure from a round the read has left is not shown."
 *   Spec 2: "The payout steps and confirmation never claim something the chain has not done."
 *
 * 1. Two members release at once on a Solana circle: the other member's release lands first, ours is refused by the
 *    program (BadMemberAccounts: round 1's recipient is no longer this round's), and the next read is already round 2.
 *    The shared payout panel hides the failure, but the page's own status line in "Your next step" still says the
 *    release was refused.
 * 2. A round with a seat settled in default, released: once released, the payout steps say "Every seat has paid round
 *    N", although the defaulted seat paid nothing (its share came from the escrow). Before this PR the Robinhood page
 *    said "Every seat has paid or been settled for round N".
 *
 * Harness: tests/a7-circle-page.spec.ts (LiveCircle rendered with react-dom/server, its useState calls seeded, the
 * wallet and the frame's wallet layer stubbed), plus its useRef calls seeded (latest, releasing: the round, seat and
 * pot a release was sent for). The refusal text is built by the app's own explainFailure from the program's IDL code.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-adversary.spec.ts     (installs hooks: its own process)
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
import { explainFailure } from "../app/src/lib/contribute.ts";
import { payoutSteps } from "../app/src/lib/core/circle-page.ts";
import { RH_WORDS, releaseSteps } from "../app/src/lib/robinhood/circle-view.ts";

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

describe("A7 adversary: the shared single-circle page", () => {
  beforeEach(() => {
    g.__sets = [];
    g.__wallet = { publicKey: new anchor.web3.PublicKey(wallets[2]!), sendTransaction: async () => "x" };
    g.__conn = {};
  });

  it("a release refused in round 1, read now in round 2: the failure is not shown anywhere on the page", async () => {
    // the program's own refusal, as send() words it for a transaction the chain refused (LiveCircle.tsx send)
    const refused = explainFailure(Object.assign(new Error('{"InstructionError":[0,{"Custom":6019}]}'), { logs: [], onChain: true }));
    assert.match(refused, /^BadMemberAccounts/, "the IDL names code 6019");
    const pay = { phase: "failed", what: "Release pot to Ada", reason: `sent, and the program refused it. ${refused}`, sig: "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn" };
    // sent for round 1 (index 0), to Ada (turn 0), the 5-seat pot
    const releasing = { round: 0, turn: 0, amount: BigInt(base.contribution) * BigInt(base.n) };
    // the read has moved on: another member's release paid Ada round 1, and round 2 has just opened
    const round2: CircleView = { ...base, round: 1, paidBitmap: 0, receivedBitmap: 0b00001, defaultedBitmap: 0, roundDeadline: NOW + 600 };
    const text = await render(round2, pay, releasing);
    // the shared payout panel follows the rule (precondition: the harness reaches the page)
    assert.match(text, /This round's payout/);
    assert.match(text, /Release pot to Tunde/, "the panel offers round 2's release");
    assert.doesNotMatch(text.slice(text.indexOf("This round's payout"), text.indexOf("Your next step")), /refused/, "the panel hides it");
    // the rule itself: a failure from a round the read has left is not shown
    assert.doesNotMatch(text, /program refused it/, "a failure from a round the read has left is still on the page");
  });

  describe("payout steps once released, with a seat settled in default", () => {
    // Round 2 (index 1): seat 1 took round 1's pot, missed round 2 and was settled in default; the others paid; the pot
    // is released to seat 2. The next read is round 3 (index 2): paid bits cleared, seat 1 still defaulted.
    const after = [
      { turn: 0, paid: false, defaulted: true, received: true },
      { turn: 1, paid: false, defaulted: false, received: true },
      { turn: 2, paid: false, defaulted: false, received: false },
    ];
    const released = { kind: "released" as const, hash: "0xabc", round: 1, recipientTurn: 1, amount: 30_000_000n };

    it("shared steps: do not say every seat paid", () => {
      const steps = payoutSteps({ n: 3, round: 2, seats: after, gateShortBy: 0n }, released, RH_WORDS, { coverRefused: false, unfunded: false });
      assert.doesNotMatch(steps[0]!.detail, /^Every seat has paid round \d+$/, `seat 1 paid nothing in round 2, yet: "${steps[0]!.detail}"`);
    });

    it("Robinhood page's releaseSteps: do not say every seat paid", () => {
      const v = { n: 3, round: 2, seats: after, nextGateShortBy: 0n } as unknown as Parameters<typeof releaseSteps>[0];
      const steps = releaseSteps(v, released);
      assert.doesNotMatch(steps[0]!.detail, /^Every seat has paid round \d+$/, `seat 1 paid nothing in round 2, yet: "${steps[0]!.detail}"`);
    });
  });
});
