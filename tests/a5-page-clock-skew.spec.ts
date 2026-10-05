/**
 * Codex review of PR #22 at e7754a1 (MEDIUM): the page took the later of the chain's time and the device clock, so a
 * device clock that runs ahead showed unpaid seats as late, "Grace ended", and offered "Record missed payment" while
 * the chain was still inside grace. OthelloCircle.markDelinquent (evm/src/OthelloCircle.sol) refuses until
 * block.timestamp > deadline + graceSecs, so the page claimed a state the chain had not reached. Rule pinned here:
 * late, "Grace ended" and the record action come from the chain's own time in the last read (RhCircleView.chainTime,
 * the latest block's timestamp), never from the device clock.
 *
 * Harness: the real RobinhoodCircle.tsx under a minimal hook runner, the same one as
 * tests/a5-release-failure-linger-adversary.spec.ts. Only I/O modules are stubbed; circle-view.ts is the real module.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-page-clock-skew.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";

const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "components/robinhood/RobinhoodCircle.tsx");

// ---------------------------------------------------------------- a minimal hook runner, one component instance
type El = { type: unknown; props: Record<string, unknown> };
type Effect = { deps?: unknown[]; cleanup?: () => void; pending?: () => void | (() => void) };
const mini = {
  slots: [] as unknown[],
  effects: [] as Effect[],
  i: 0,
  e: 0,
  render: null as null | (() => El),
  tree: null as El | null,
  scheduled: false,
};
const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
function rerender() {
  mini.scheduled = false;
  mini.i = 0;
  mini.e = 0;
  mini.tree = mini.render!();
  for (const ef of mini.effects) {
    if (ef.pending) {
      ef.cleanup?.();
      const out = ef.pending();
      ef.pending = undefined;
      ef.cleanup = typeof out === "function" ? out : undefined;
    }
  }
}
function schedule() {
  if (mini.scheduled) return;
  mini.scheduled = true;
  queueMicrotask(rerender);
}
const ReactStub = {
  useState<T>(init: T | (() => T)) {
    const k = mini.i++;
    if (!(k in mini.slots)) mini.slots[k] = typeof init === "function" ? (init as () => T)() : init;
    const set = (next: T | ((p: T) => T)) => {
      const val = typeof next === "function" ? (next as (p: T) => T)(mini.slots[k] as T) : next;
      if (!Object.is(val, mini.slots[k])) {
        mini.slots[k] = val;
        schedule();
      }
    };
    return [mini.slots[k] as T, set] as const;
  },
  useRef<T>(init: T) {
    const k = mini.i++;
    if (!(k in mini.slots)) mini.slots[k] = { current: init };
    return mini.slots[k] as { current: T };
  },
  useMemo<T>(fn: () => T, deps: unknown[]) {
    const k = mini.i++;
    const prev = mini.slots[k] as { deps: unknown[]; v: T } | undefined;
    if (!prev || changed(prev.deps, deps)) mini.slots[k] = { deps, v: fn() };
    return (mini.slots[k] as { v: T }).v;
  },
  useCallback<T>(fn: T, deps: unknown[]) {
    return ReactStub.useMemo(() => fn, deps);
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const k = mini.e++;
    const ef = (mini.effects[k] ??= {});
    if (changed(ef.deps, deps) || ef.deps === undefined) {
      ef.pending = fn;
      ef.deps = deps ?? [];
      if (deps === undefined) ef.deps = undefined;
    }
  },
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  Fragment: "fragment",
};
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });

// ---------------------------------------------------------------- the I/O the page touches, driven by the test
const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;
const CIRCLE = "0x9999999999999999999999999999999999999999";
const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

const io = {
  view: null as RhCircleView | null,
  intervals: [] as { fn: () => void; ms: number }[],
  onSent: null as null | ((h: `0x${string}`) => void),
  releaseCalls: 0,
  settleRelease: null as null | ((r: unknown) => void),
};
const g = globalThis as Record<string, unknown>;
g.__mini = ReactStub;
g.__jsx = jsx;
g.__io = io;
g.React = ReactStub;
g.window = {
  setInterval: (fn: () => void, ms: number) => io.intervals.push({ fn, ms }) - 1,
  clearInterval: () => {},
};

const STUBS: Record<string, string> = {
  react: `const m = globalThis.__mini; export default m; export const { useState, useRef, useMemo, useCallback, useEffect, createElement, Fragment } = m;`,
  "react/jsx-runtime": `export const jsx = globalThis.__jsx, jsxs = globalThis.__jsx, Fragment = "fragment";`,
  "react/jsx-dev-runtime": `export const jsxDEV = globalThis.__jsx, Fragment = "fragment";`,
  "@/components/othello/Shell": `export default function Shell() { return null; }`,
  "@/lib/wallet": `export const useWalletUi = () => ({ openConnect() {} });`,
  "@/lib/robinhood/wallet": `
    export const robinhoodPublicClient = { getTransactionReceipt: async () => { throw new Error("not reached"); } };
    export const useEvmWallet = () => ({ hasWallet: true, address: "${W(1)}", walletClient: { tag: "wallet" }, onRobinhood: true,
      error: null, switchToRobinhood() {} });`,
  "@/lib/robinhood/adapter": `
    const io = globalThis.__io;
    export const trustedFactory = null;
    export const topUpFill = (d, a) => (d < a ? d : a);
    export const checkTrusted = async () => ({ ok: true });
    export const readCircle = async () => io.view;
    export function createRobinhoodAdapter(d) {
      io.onSent = d.onSent;
      return { releasePot: () => { io.releaseCalls++; return new Promise((r) => { io.settleRelease = r; }); } };
    }`,
};

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier in STUBS) return stub(STUBS[specifier]!);
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

// ---------------------------------------------------------------- chain state: n=3, c=2 USDG, round 1 then round 2
function seat(turn: number, over: Partial<RhSeat>): RhSeat {
  return { turn, wallet: W(turn), collateral: 10n * U, g: 2n * U, topUps: 0n, forfeited: 0n, allocated: 0n, lastCoverageBps: 0,
    delinquentMarks: 0, roundsPaid: 1, joined: true, paid: true, received: false, defaulted: false, marked: false, withdrawn: false, ...over };
}
// The device clock (what Date.now() gives the page) is ten minutes ahead of the chain. The read was taken just now on
// this device (readAt, as adapter-core readCircle stamps it) and the chain's latest block is ten minutes earlier.
const device = Math.floor(Date.now() / 1000);
const SKEW = 600;
const graceSecs = 3_600;
// round 2 (index 1), seat 1 has received and paid, seats 2 and 3 have not paid round 2
function readAt(chainTime: number, graceEnds: number): RhCircleView {
  return {
    address: CIRCLE as `0x${string}`, factory: W(8), creator: W(0), n: 3, c: 2n * U, g: 2n * U, minStockCover: 900_000n, haircutBps: 1000,
    coverageBps: 10000, warnBps: 10000 - 1, roundSecs: 86_400, graceSecs, status: "Active", round: 1, deadline: graceEnds - graceSecs,
    reserveTotal: 6n * U, reserveLosses: 0n, reserveAllocated: 0n, escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n,
    collateralReturned: 0n, depositsTotal: 8n * U, forfeitedTotal: 0n, nextGateShortBy: 0n, heldContributions: 2n * U, lastCoverageAt: 0,
    balance: 32n * U, surplus: 0n, readAt: device, chainTime,
    seats: [seat(0, { received: true }), seat(1, { paid: false }), seat(2, { paid: false })],
  } as RhCircleView;
}

function find(el: unknown, pred: (e: El) => boolean): El | null {
  if (!el || typeof el !== "object") return null;
  if (Array.isArray(el)) {
    for (const x of el) {
      const hit = find(x, pred);
      if (hit) return hit;
    }
    return null;
  }
  const e = el as El;
  if (e.props && pred(e)) return e;
  return e.props ? find(e.props.children, pred) : null;
}
const ringEl = () => find(mini.tree, (e) => "ring" in e.props && "pot" in e.props);
const payments = () => (ringEl()!.props.ring as { seats: { payment: string | null }[] }).seats.map((s) => s.payment);
const recordButtons = () => {
  const hits: El[] = [];
  find(mini.tree, (e) => { if (e.type === "button" && e.props.children === "Record missed payment") hits.push(e); return false; });
  return hits.length;
};
const text = (el: unknown): string =>
  el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el)
    : Array.isArray(el) ? el.map(text).join("") : text((el as El).props?.children);
const settle = async () => {
  for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0));
};

function reset() {
  mini.slots = [];
  mini.effects = [];
  mini.tree = null;
  io.intervals = [];
  io.releaseCalls = 0;
  io.settleRelease = null;
}

async function mount(view: RhCircleView) {
  const mod = await import(pathToFileURL(PAGE).href);
  mini.render = () => mod.default({ address: CIRCLE });
  io.view = view;
  rerender();
  await settle();
  assert.ok(ringEl(), "the ring is shown for an active circle");
}

describe("Codex r1 on PR #22: late and the missed-payment action follow the chain's time, not the device clock", () => {
  beforeEach(reset);

  it("control: once the chain's own time is past grace, seats 2 and 3 are late and can be recorded", async () => {
    const chain = device - SKEW;
    await mount(readAt(chain, chain - 1));
    assert.deepEqual(payments(), ["paid", "late", "late"]);
    assert.equal(recordButtons(), 2);
    assert.match(text(mini.tree), /Grace ended/);
  });

  it("a device clock ten minutes ahead, with the chain still 60 s inside grace: nobody is late, no record action", async () => {
    const chain = device - SKEW;
    await mount(readAt(chain, chain + 60));
    assert.deepEqual(payments(), ["paid", "due", "due"],
      "the chain has not reached deadline + grace; markDelinquent would revert, so the seats are still due");
    assert.equal(recordButtons(), 0, "Record missed payment is offered before the contract can accept it");
    assert.doesNotMatch(text(mini.tree), /Grace ended/);
  });

  it("the page's clock ticks on: still not late until a read shows the chain past grace", async () => {
    const chain = device - SKEW;
    await mount(readAt(chain, chain + 60));
    // the page's one-second tick and its 8 s read run with the device clock still ahead; the chain has not moved
    for (const t of io.intervals) t.fn();
    await settle();
    assert.deepEqual(payments(), ["paid", "due", "due"]);
    assert.equal(recordButtons(), 0);
    // the next read shows a block past grace
    io.view = readAt(chain + 61, chain + 60);
    io.intervals.find((x) => x.ms === 8_000)!.fn();
    await settle();
    assert.deepEqual(payments(), ["paid", "late", "late"]);
    assert.equal(recordButtons(), 2);
  });
});
