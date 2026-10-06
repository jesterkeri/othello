/**
 * Adversary, A5 (Robinhood circle page, Joshua 2026-10-05), pass on 05b8701. Spec item 3: "an old failure does not
 * linger into a new round". RobinhoodCircle clears a failed release only when the read's round changes
 * (useEffect on view.round). It does not check which round the failure belongs to when the failure arrives.
 *
 * The race is two members pressing Release at the same time (evm/src/OthelloCircle.sol releasePot: any address may
 * call it). Member B (seat 2, this page) sends a release for round 1 while member A's release for round 1 is pending.
 * A's lands first: the round moves to 2 and every paidBitmap bit clears, so B's transaction reverts
 * (RoundNotFunded) and the adapter returns its literal on-chain failure (app/src/lib/robinhood/adapter-core.ts send:
 * { ok: false, error: "Failed", message: "The transaction failed on chain." }). The page's 8 second read runs while
 * B's transaction is still pending, so the page already shows round 2 when B's failure comes back. That failure is
 * about round 1, yet it now stays on round 2's payout panel (role="alert", wallet step blocked) until round 3.
 *
 * Harness: the real RobinhoodCircle.tsx, with react replaced by a minimal hook runner (useState, useEffect, useRef,
 * useMemo, useCallback with real dependency checks) so effects and async callbacks run without a DOM. Only I/O
 * modules are stubbed: the wallet hook, the public client, readCircle/checkTrusted and the adapter. circle-view.ts,
 * copy.ts, chain.ts and reserve-display.ts are the real modules.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-release-failure-linger-adversary.spec.ts
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
const now = Math.floor(Date.now() / 1000);
const base: Omit<RhCircleView, "round" | "seats" | "heldContributions"> = {
  address: CIRCLE as `0x${string}`, factory: W(8), creator: W(0), n: 3, c: 2n * U, g: 2n * U, minStockCover: 900_000n, haircutBps: 1000,
  coverageBps: 10000, warnBps: 10000 - 1, roundSecs: 86_400, graceSecs: 3_600, status: "Active", deadline: now + 86_000,
  reserveTotal: 6n * U, reserveLosses: 0n, reserveAllocated: 0n, escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n,
  collateralReturned: 0n, depositsTotal: 6n * U, forfeitedTotal: 0n, nextGateShortBy: 0n, lastCoverageAt: 0,
  balance: 36n * U, surplus: 0n, readAt: now, chainTime: now, block: 1,
} as never;
// round 1 (index 0): every seat has paid; the pot (6 USDG) goes to seat 1
const round1 = { ...base, round: 0, heldContributions: 6n * U, seats: [seat(0, {}), seat(1, {}), seat(2, {})] } as RhCircleView;
// after member A's release: round 2 (index 1), seat 1 received, nobody has paid round 2 yet
const round2 = { ...base, round: 1, heldContributions: 0n, balance: 30n * U,
  seats: [seat(0, { paid: false, received: true }), seat(1, { paid: false }), seat(2, { paid: false })] } as RhCircleView;

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
const payoutPanel = () => find(mini.tree, (e) => "phase" in e.props && "steps" in e.props && "onRelease" in e.props);
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

describe("A5 adversary: a release that failed in round 1 does not stay on round 2's payout panel", () => {
  beforeEach(reset);

  it("control: the harness runs the page's own reset when the failure comes before the round moves", async () => {
    const mod = await import(pathToFileURL(PAGE).href);
    mini.render = () => mod.default({ address: CIRCLE });
    io.view = round1;
    rerender();
    await settle();
    (payoutPanel()!.props.onRelease as () => void)();
    await settle();
    io.settleRelease!({ ok: false, error: "Failed", args: [HASH], message: "The transaction failed on chain." });
    await settle();
    assert.equal((payoutPanel()!.props.phase as { kind: string }).kind, "failed", "the failure shows in its own round");
    io.view = round2;
    io.intervals.find((x) => x.ms === 8_000)!.fn();
    await settle();
    assert.equal((payoutPanel()!.props.phase as { kind: string }).kind, "idle", "the page clears it once the read shows round 2");
  });

  it("member B's failed race against member A is cleared once the page shows round 2", async () => {
    const mod = await import(pathToFileURL(PAGE).href);
    mini.render = () => mod.default({ address: CIRCLE });
    io.view = round1;
    rerender();
    await settle();

    const before = payoutPanel();
    assert.ok(before, "the payout panel is shown for an active circle");
    assert.equal((before.props.button as { enabled: boolean }).enabled, true, "round 1 is settled: release is enabled");
    assert.equal((before.props.button as { recipientTurn: number }).recipientTurn, 0);

    // B presses Release for round 1; the wallet sends it
    (before.props.onRelease as () => void)();
    await settle();
    assert.equal(io.releaseCalls, 1);
    io.onSent!(HASH);
    await settle();
    assert.equal((payoutPanel()!.props.phase as { kind: string }).kind, "sent");

    // A's release lands first; the page's own 8 second read shows round 2 while B's transaction is still pending
    io.view = round2;
    io.intervals.find((x) => x.ms === 8_000)!.fn();
    await settle();
    assert.equal((payoutPanel()!.props.button as { recipientTurn: number }).recipientTurn, 1, "the page now shows round 2");

    // B's transaction reverts on chain (round 2 is unpaid): the adapter's literal on-chain failure
    io.settleRelease!({ ok: false, error: "Failed", args: [HASH], message: "The transaction failed on chain." });
    await settle();

    const after = payoutPanel()!;
    const phase = after.props.phase as { kind: string; message?: string };
    const wallet = (after.props.steps as { key: string; status: string; detail: string }[]).find((s) => s.key === "wallet")!;
    assert.notEqual(phase.kind, "failed",
      `round 2's payout panel still carries round 1's failure: "${phase.message}"; wallet step ${wallet.status}: "${wallet.detail}"`);
  });
});
