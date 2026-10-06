/**
 * A6 adversary on dd59b76: the shared circles list shows Paused (the chain's stored next_gate_short_by > 0) and tells
 * the round's recipient to "top up" that much reserve, but never says when that figure was checked. SPEC.md, "Payout
 * gate" paragraph: "Paused is defined on-chain as next_gate_short_by > 0; the UI never computes it. It is as of the
 * last update_coverage / release_pot / declare_default / top_up_reserve; add_stock and price changes do not refresh it.
 * The UI shows the last-checked age next to Paused". The Solana circle page does (components/live/LiveCircle.tsx, "At
 * the last coverage check (... ago) payouts were paused"); the list does not: ListCircle (lib/core/circle-list.ts)
 * carries no last-checked time, so a Paused card read a minute after its check and one read three days after it say
 * exactly the same thing, and the recipient is asked to put money in on a figure of unknown age.
 *
 * The check is wording-free: the same paused circle is listed twice, differing only in lastCoverageAt (5 minutes and 3
 * days before the read), and the page drawn for each must differ. Fixture: the design's active circle
 * (app/src/fixtures/circles.ts CIRCLE_STATES.active, as tests/a6-circles-list-solana.spec.ts uses), every seat paid,
 * next_gate_short_by 5 USDC. The page is the real CirclesHome rendered with react-dom/server, from the source
 * useSolanaCircles builds (solToList, circleCard).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-paused-age-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { CIRCLE_STATES, FIXTURE_NOW } from "../app/src/fixtures/circles.ts";
import type { CircleView } from "../app/src/lib/circle.ts";
import type { LiveCircle } from "../app/src/lib/live.ts";

const SRC = resolve(REPO, "app/src");
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

const ADDR = "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q";
const live = (view: CircleView): LiveCircle => ({
  view,
  accounts: { circle: ADDR, usdcMint: "x", stockMint: "y" },
  split: { multiplier: 1e9, newMultiplier: 1e9, effectiveAt: 0 },
  pool: { discountBps: 0, usdc: 0 },
  readAt: FIXTURE_NOW,
});

describe("A6 adversary: a Paused card in the circles list says how old the Paused figure is", () => {
  const base = CIRCLE_STATES.active;
  const wallet = (turn: number) => base.members.find((m) => m.turn === turn)!.address;
  // every seat paid, so the pot is releasable by the program's other rules; the chain's stored figure says Paused
  const paused = (lastCoverageAt: number): CircleView => ({ ...base, paidBitmap: 0b11111, nextGateShortBy: 5_000_000, lastCoverageAt });

  async function page(view: CircleView, me: string): Promise<string> {
    const React = appRequire("react");
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { solToList } = await import(pathToFileURL(resolve(SRC, "lib/to-list-solana.ts")).href);
    const { default: CirclesHome } = await import(pathToFileURL(resolve(SRC, "components/circles/CirclesHome.tsx")).href);
    const source = {
      side: "solana",
      chainName: "Solana devnet",
      wallet: { installed: true, address: me, connect: () => {}, connectLabel: "", installHint: "" },
      blocked: null,
      found: 1,
      circles: [solToList(live(view), me)],
      notShown: 0,
      reading: 0,
      failed: [],
      error: null,
      retry: null,
      more: null,
    };
    return renderToStaticMarkup(React.createElement(CirclesHome, { source }));
  }

  for (const [who, turn] of [["the recipient (told to top up)", base.round], ["another member (shown Paused)", base.round + 1]] as const) {
    it(`${who}: a check 5 minutes old and one 3 days old are told apart`, async () => {
      const recent = await page(paused(FIXTURE_NOW - 300), wallet(turn));
      const old = await page(paused(FIXTURE_NOW - 3 * 86_400), wallet(turn));
      assert.match(recent, /Payouts paused/, "precondition: the card shows Paused");
      assert.notEqual(old, recent, "the Paused card shows no last-checked age: a 3-day-old figure reads exactly like a fresh one");
    });
  }
});
