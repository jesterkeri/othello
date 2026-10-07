/**
 * Adversary on d9a3db1 (PR #25, shared circles list). Spec 1: "every listed circle is read, or shown as a failed row
 * with a link and a working Try again".
 *
 * On Solana the failed row's Try again (useSolanaCircles in app/src/components/live/SolanaHome.tsx, retryFailed) asks
 * /api/circles again. That route (app/src/app/api/circles/route.ts) caches the whole answer for CACHE_SECONDS (10 s),
 * failed circles included, so a Try again inside that window gets the same failed row back without anything being read
 * again: the button does nothing for the first ten seconds after the failure, the moment a person presses it.
 *
 * Attack: the wallet has one circle. The first scan finds it but its read fails (devnet rate-limited the Member
 * reads, say); a second scan would read it. The page's Try again is pressed two seconds later.
 * Harness: the real useSolanaCircles, run by the same small hook runner as tests/robinhood-read-failed-no-circles-
 * adversary.spec.ts; the browser's fetch of /api/circles is answered by the real route handler (GET), whose scan
 * (solanaCirclesOf) is replaced by one that fails the circle's read the first time only. The circle that reads is the
 * design's own fixture (app/src/fixtures/circles.ts CIRCLE_STATES.active), as tests/a6-circles-list-solana.spec.ts uses.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-solana-retry-cached-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { CIRCLE_STATES, FIXTURE_NOW } from "../app/src/fixtures/circles.ts";
import type { LiveCircle } from "../app/src/lib/live.ts";
import { parseAddress } from "../app/src/lib/sol-address.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));
// the circle address tests/a6-circles-list-solana.spec.ts uses for the same fixture
const CIRCLE = "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q";
const view = CIRCLE_STATES.active;
// the wallet: any valid Solana address (the fixture's seat names are display strings, not base58 keys, and the route
// refuses them); which seat it holds does not matter here, only whether the circle is read or a failed row
const WALLET = "11111111111111111111111111111111";
const live: LiveCircle = {
  view,
  accounts: { circle: CIRCLE, usdcMint: "x", stockMint: "y" },
  split: { multiplier: 1e9, newMultiplier: 1e9, effectiveAt: 0 },
  pool: { discountBps: 0, usdc: 0 },
  readAt: FIXTURE_NOW,
};

type Slot = { v?: unknown; current?: unknown; f?: unknown; d?: unknown[]; cleanup?: unknown };
const g = globalThis as {
  __a6s?: ReturnType<typeof hooks>; __a6sScan?: unknown; __a6sParse?: unknown; __a6sOwn?: unknown; __a6sWallet?: string;
};

/** One component's hooks, run by hand: state persists across renders, effects run when their deps change. */
function hooks() {
  const slots: Slot[] = [];
  const queue: (() => void)[] = [];
  let i = 0;
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((x, k) => Object.is(x, b[k])));
  return {
    begin() {
      i = 0;
    },
    useState(init: unknown) {
      const k = i++;
      if (!slots[k]) slots[k] = { v: typeof init === "function" ? (init as () => unknown)() : init };
      const s = slots[k]!;
      return [s.v, (x: unknown) => { s.v = typeof x === "function" ? (x as (p: unknown) => unknown)(s.v) : x; }];
    },
    useRef(init: unknown) {
      const k = i++;
      if (!slots[k]) slots[k] = { current: init };
      return slots[k];
    },
    useCallback(f: unknown, d: unknown[]) {
      const k = i++;
      if (slots[k] && same(slots[k]!.d, d)) return slots[k]!.f;
      slots[k] = { f, d };
      return f;
    },
    useEffect(f: () => unknown, d: unknown[]) {
      const k = i++;
      const s = slots[k];
      if (s && same(s.d, d)) return;
      queue.push(() => {
        if (typeof s?.cleanup === "function") (s.cleanup as () => void)();
        slots[k] = { d, cleanup: f() };
      });
    },
    flush() {
      for (const q of queue.splice(0)) q();
    },
  };
}

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    const fromHome = context.parentURL?.endsWith("/components/live/SolanaHome.tsx") ?? false;
    const fromRoute = context.parentURL?.endsWith("/app/api/circles/route.ts") ?? false;
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (fromHome && specifier === "react") {
      return stub(
        "const H = () => globalThis.__a6s;" +
        "export const useState = (i) => H().useState(i);" +
        "export const useRef = (i) => H().useRef(i);" +
        "export const useCallback = (f, d) => H().useCallback(f, d);" +
        "export const useEffect = (f, d) => H().useEffect(f, d);",
      );
    }
    if (fromHome && specifier === "@solana/wallet-adapter-react") {
      return stub("export const useWallet = () => ({ publicKey: { toBase58: () => globalThis.__a6sWallet }, wallets: [] });");
    }
    if (fromHome && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ openConnect: () => {} });");
    if (fromHome && specifier === "@/components/othello/Shell") return stub("export default (p) => p.children;");
    // the route's scan: the RPC is replaced, the route's own caching and answer are real
    if (fromRoute && specifier === "@/lib/solana-circles") {
      return stub(
        "export const solanaCirclesOf = (...a) => globalThis.__a6sScan(...a);" +
        "export const parseAddress = (x) => globalThis.__a6sParse(x);" +
        "export const OWN_ERROR = globalThis.__a6sOwn;",
      );
    }
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

describe("Adversary on d9a3db1: the Solana list's Try again for a failed circle", function () {
  this.timeout(60_000);
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("reads the failed circle again when Try again is pressed, instead of answering the cached failure", async () => {
    // the first scan's read of the circle fails; any later scan reads it
    let scans = 0;
    g.__a6sScan = async () => {
      scans += 1;
      return scans === 1 ? { circles: [], failed: [CIRCLE], total: 1 } : { circles: [live], failed: [], total: 1 };
    };
    g.__a6sParse = parseAddress;
    g.__a6sOwn = /^(No circle at)/;
    g.__a6sWallet = WALLET;
    g.__a6s = hooks();

    const { GET } = await import(pathToFileURL(resolve(SRC, "app/api/circles/route.ts")).href);
    const { NextRequest } = appRequire("next/server");
    // the browser's fetch of the app's own route, answered by the route handler
    let answered = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      assert.ok(url.startsWith("/api/circles?"), `unexpected fetch ${url}`);
      const res = await GET(new NextRequest(`http://localhost${url}`));
      answered += 1;
      return res;
    }) as typeof fetch;

    const { useSolanaCircles } = await import(pathToFileURL(resolve(SRC, "components/live/SolanaHome.tsx")).href);
    const h = g.__a6s!;
    const step = () => {
      h.begin();
      const s = useSolanaCircles();
      h.flush();
      return s;
    };
    let source = step();
    for (let k = 0; k < 100 && source.failed.length === 0; k++) {
      await sleep(20);
      source = step();
    }
    assert.equal(source.error, null, "precondition: the route answered");
    assert.equal(source.found, 1, "precondition: the wallet's one circle was found");
    assert.equal(source.failed.length, 1, "precondition: its read failed and it is a failed row");
    assert.equal(typeof source.retryFailed, "function", "precondition: the failed row offers Try again");

    // a person reads the row and presses Try again two seconds later
    await sleep(2_000);
    source.retryFailed!();
    for (let k = 0; k < 100 && answered < 2; k++) await sleep(20);
    assert.equal(answered, 2, "precondition: Try again asked the route again");
    await sleep(50);
    source = step();

    assert.equal(
      source.failed.length, 0,
      `Try again drew the same failed row: the circle was scanned ${scans} time(s), the route answered its cached failure`,
    );
    assert.equal(source.circles.length, 1, "the circle, readable now, is drawn after Try again");
  });
});
