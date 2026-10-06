/**
 * Adversary, A5 (Robinhood circle page, Joshua 2026-10-05), pass on 77f0185. Spec item 3: a completed circle must say
 * clearly "what the connected member gets". The real app/src/components/robinhood/CloseOutPanel.tsx is rendered with
 * react-dom/server (the app's own React 19.1.1) from closeOutOf over a Completed circle whose every number follows
 * evm/src/OthelloCircle.sol step by step (history below). What withdraw() pays is fixed by that state: in Completed no
 * function can change reserveTotal, reserveLosses, escrow, depositsTotal or forfeitedTotal, and withdraw() itself only
 * moves withdrawnFromReserve and collateralReturned, so the share is exact and the same in any withdrawal order.
 *
 * History (n=3, c=2, g=2, haircut 10%, coverage 100%, minStockCover 0.9, all USDG; factory peakNeed 3.1 <= n*g 6):
 *   join: seat 1 locks 1, seats 2 and 3 lock 10; reserveTotal 6, depositsTotal 6.
 *   round 1: all pay; gate needs 3.1 <= 6; pot 6 to seat 1.
 *   round 2: seats 2, 3 pay; seat 1 marked, then declareDefault(0): o = 2*(3-1) = 4, seized 1 (collateral 0),
 *            shortfall 3, loss 3 (reserveLosses 3), escrow 4, forfeited = min(3, g 2) = 2 (forfeitedTotal 2).
 *            release: escrow pays seat 1 (escrow 2); gate sum 0.
 *   round 3: seats 2, 3 pay; release: escrow pays seat 1 (escrow 0); status Completed, round stays 2.
 *   withdraw(): poolLeft = 6 - 3 + 0 = 3, denom = 6 - 2 = 4.
 *            seat 1: collateral 0 + 3 * (2 - 2) / 4 = 0.      seats 2, 3: 10 + 3 * 2 / 4 = 11.5 each.
 *   check: in 27 (joins) + 6 + 4 + 4 (payments) - 18 (pots) = 23 = 0 + 11.5 + 11.5 out.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-closeout-share-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { closeOutOf } from "../app/src/lib/robinhood/circle-view.ts";

const SRC = resolve(REPO, "app/src");
const PANEL = resolve(SRC, "components/robinhood/CloseOutPanel.tsx");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
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

const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;
const U32_MAX = 4_294_967_295;

function seat(turn: number, over: Partial<RhSeat>): RhSeat {
  return { turn, wallet: W(turn), collateral: 10n * U, g: 2n * U, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: U32_MAX,
    delinquentMarks: 0, roundsPaid: 3, joined: true, paid: true, received: true, defaulted: false, marked: false, withdrawn: false, ...over };
}

const completed: RhCircleView = {
  address: W(9), factory: W(8), creator: W(0), n: 3, c: 2n * U, g: 2n * U, minStockCover: 900_000n, haircutBps: 1000, coverageBps: 10000,
  warnBps: 10000 - 1, roundSecs: 86_400, graceSecs: 3_600, status: "Completed", round: 2, deadline: 0,
  reserveTotal: 6n * U, reserveLosses: 3n * U, reserveAllocated: 0n, escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n,
  collateralReturned: 0n, depositsTotal: 6n * U, forfeitedTotal: 2n * U, nextGateShortBy: 0n, heldContributions: 0n, lastCoverageAt: 0,
  balance: 23n * U, surplus: 0n,
  seats: [seat(0, { collateral: 0n, forfeited: 2n * U, defaulted: true, delinquentMarks: 1 }), seat(1, {}), seat(2, {})],
  readAt: 0, chainTime: 0, block: 1,
};

/** OthelloCircle.withdraw() in Completed, written out independently of the app. */
function contractPays(v: RhCircleView, turn: number): bigint {
  const s = v.seats[turn]!;
  const poolLeft = v.reserveTotal - v.reserveLosses + v.escrow;
  const denom = v.depositsTotal - v.forfeitedTotal;
  const pooled = denom === 0n ? 0n : (poolLeft * (s.g + s.topUps - s.forfeited)) / denom;
  return s.collateral + pooled;
}

async function panelText(me: string): Promise<string> {
  const React = appRequire("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const mod = await import(pathToFileURL(PANEL).href);
  const close = closeOutOf(completed, me)!;
  const html: string = renderToStaticMarkup(React.createElement(mod.default, { close, completed: true, canWrite: true, blocker: null, busy: false, onWithdraw: () => {} }));
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("A5 adversary: a completed circle tells the connected member what withdraw() pays", () => {
  it("the reference arithmetic matches the circle's balance: 0 + 11.5 + 11.5 = 23 USDG", () => {
    assert.equal(contractPays(completed, 0), 0n);
    assert.equal(contractPays(completed, 1), 11_500_000n);
    assert.equal(contractPays(completed, 0) + contractPays(completed, 1) + contractPays(completed, 2), completed.balance);
  });

  it("a member in good standing is told the amount withdraw() pays them (11.5 USDG)", async () => {
    const text = await panelText(W(1));
    assert.ok(text.includes("11.5 USDG"), `seat 2 gets 11.5 USDG from withdraw(); the panel says: ${text}`);
  });

  it("a defaulted member whose guarantee was forfeited is not promised a share of the reserve (withdraw() pays them 0)", async () => {
    const text = await panelText(W(0));
    assert.doesNotMatch(text, /plus your share of the shared reserve/, `seat 1's pooled share is 0; the panel says: ${text}`);
  });
});
