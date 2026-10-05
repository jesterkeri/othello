/**
 * Adapted on 7 stages (fix pass on 594acfe): the entrance is now the logo unfolding (logo -> grow -> unfold -> draw ->
 * spin -> settled, timers only), and stages only move forward. The rule pinned is unchanged: after the load-in, a round
 * change uses the pot-then-turn transition (.ready), whatever order the timers fire in.
 *
 * Adversary, A5 ring that turns on every load (Joshua, 2026-10-05), pass on 594acfe. Spec item 2: "When a later chain
 * read shows a pot was released, the pot travels to the receiving seat and the ring then turns to the next receiver;
 * that motion must still work after the load-in turn."
 *
 * CircleRing.tsx moves its stage start -> entering on the second animation frame after mount, and to settled on a
 * 1900 ms timer. Nothing stops those frames from arriving after the timer: Chrome does not run
 * requestAnimationFrame in a hidden tab (a circle opened in a background tab) while its timers still run, and a phone
 * whose main thread is busy for two seconds at load runs the due timer before the second frame. Then the stage goes
 * settled -> entering and stays "entering" for the life of the page. Every later round change then uses the load-in
 * transition (CircleRing.module.css .entering: 1.6 s, no delay) instead of the round-change one (.ready: .65 s delay,
 * so the pot reaches the seat first), so the ring turns away while the pot is still flying to it.
 *
 * Harness: the real CircleRing.tsx (bundled by esbuild, the copy tsx ships) with react replaced by a minimal hook
 * runner (useState, useRef, useEffect with dependency checks), and requestAnimationFrame / setTimeout driven by the
 * test. Rings come from the repo's own ringOf over a constructed read (n=3, Active). The control (frames on time)
 * passes.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a5-ring-entrance-order-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { RhCircleView, RhSeat } from "../app/src/lib/robinhood/adapter.ts";
import { ringOf } from "../app/src/lib/robinhood/circle-view.ts";
import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
// esbuild is tsx's own dependency, not the repo's: typed here for the two calls this spec makes
type Hook = (a: { path: string }) => unknown;
type Build = { onResolve(o: { filter: RegExp }, f: Hook): void; onLoad(o: { filter: RegExp; namespace: string }, f: Hook): void };
const esbuild = createRequire(createRequire(import.meta.url).resolve("tsx"))("esbuild") as {
  build(o: Record<string, unknown> & { plugins: { name: string; setup(b: Build): void }[] }): Promise<{ outputFiles: { text: string }[] }>;
};

const U = 1_000_000n;
const W = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}` as `0x${string}`;
const seat = (turn: number, received = false): RhSeat => ({ turn, wallet: W(turn), collateral: 10n * U, g: U, topUps: 0n, forfeited: 0n,
  allocated: 0n, lastCoverageBps: 0, delinquentMarks: 0, roundsPaid: 0, joined: true, paid: false, received, defaulted: false, marked: false,
  withdrawn: false });
const readAt = (round: number): RhCircleView => ({
  address: W(9), factory: W(8), creator: W(0), n: 3, c: 2n * U, g: U, minStockCover: 10n * U, haircutBps: 1000, coverageBps: 10000, warnBps: 0,
  roundSecs: 86_400, graceSecs: 3_600, status: "Active", round, deadline: 2_000_000, reserveTotal: 0n, reserveLosses: 0n, reserveAllocated: 0n,
  escrow: 0n, escrowDeficit: 0n, withdrawnFromReserve: 0n, collateralReturned: 0n, depositsTotal: 0n, forfeitedTotal: 0n, nextGateShortBy: 0n,
  heldContributions: 0n, lastCoverageAt: 0, balance: 0n, surplus: 0n, seats: [0, 1, 2].map((t) => seat(t, t < round)), readAt: 1_000_000,
  chainTime: 1_000_000,
});

// ---------------------------------------------------------------- a minimal hook runner, one component instance
type El = { type: unknown; props: Record<string, unknown> };
type Effect = { deps?: unknown[]; cleanup?: () => void; pending?: () => void | (() => void) };
const mini = { slots: [] as unknown[], effects: [] as Effect[], i: 0, e: 0, render: null as null | (() => El), tree: null as El | null };
const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
let dirty = false;
function rerender() {
  dirty = false;
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
const hooks = {
  useState<T>(init: T) {
    const k = mini.i++;
    if (!(k in mini.slots)) mini.slots[k] = init;
    const set = (next: T | ((p: T) => T)) => {
      const val = typeof next === "function" ? (next as (p: T) => T)(mini.slots[k] as T) : next;
      if (!Object.is(val, mini.slots[k])) { mini.slots[k] = val; dirty = true; }
    };
    return [mini.slots[k] as T, set] as const;
  },
  useRef<T>(init: T) {
    const k = mini.i++;
    if (!(k in mini.slots)) mini.slots[k] = { current: init };
    return mini.slots[k] as { current: T };
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const ef = (mini.effects[mini.e++] ??= {});
    if (ef.deps === undefined || changed(ef.deps, deps)) { ef.pending = fn; ef.deps = deps ?? []; }
  },
};

// ---------------------------------------------------------------- the browser's frame and timer queues, driven by the test
let frames: { id: number; cb: () => void }[] = [];
let timers: { id: number; at: number; cb: () => void }[] = [];
let seq = 0;
const g = globalThis as Record<string, unknown>;
g.__hooks = hooks;
g.__jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
g.window_unused = 0;
g.requestAnimationFrame = (cb: () => void) => { frames.push({ id: ++seq, cb }); return seq; };
g.cancelAnimationFrame = (id: number) => { frames = frames.filter((f) => f.id !== id); };
g.window = { setTimeout: (cb: () => void, ms: number) => { timers.push({ id: ++seq, at: ms, cb }); return seq; },
  clearTimeout: (id: number) => { timers = timers.filter((t) => t.id !== id); } };
/** One animation frame: run the frame callbacks queued so far, then re-render if state moved. */
function frame() { const q = frames; frames = []; q.forEach((f) => f.cb()); if (dirty) rerender(); }
/** Every due timer, then re-render if state moved. */
function timersDue() { const q = timers; timers = []; q.forEach((t) => t.cb()); if (dirty) rerender(); }

function className(el: El | null): string {
  assert.ok(el && el.type === "figure", "CircleRing renders a figure");
  return String(el.props.className);
}

async function load(): Promise<(p: Record<string, unknown>) => El> {
  const out = await esbuild.build({
    entryPoints: [resolve(SRC, "components/robinhood/CircleRing.tsx")],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", logLevel: "silent",
    plugins: [{
      name: "stubs",
      setup(b: Build) {
        b.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime)?$/ }, (a: { path: string }) => ({ path: a.path, namespace: "stub" }));
        b.onResolve({ filter: /\.module\.css$/ }, (a: { path: string }) => ({ path: a.path, namespace: "stub" }));
        b.onResolve({ filter: /^@\// }, (a: { path: string }) => {
          const base = resolve(SRC, a.path.slice(2));
          for (const ext of [".ts", ".tsx"]) { try { readFileSync(base + ext); return { path: base + ext }; } catch { /* next */ } }
          return { path: base };
        });
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a: { path: string }) => ({
          loader: "js",
          contents: a.path.endsWith(".module.css")
            ? "export default new Proxy({}, { get: (_, k) => String(k) });"
            : a.path === "react"
              ? "const m = globalThis.__hooks; export const useState = m.useState, useRef = m.useRef, useEffect = m.useEffect;"
              : "export const jsx = globalThis.__jsx, jsxs = globalThis.__jsx, Fragment = 'fragment';",
        }));
      },
    }],
  });
  const mod = { exports: {} as { default: (p: Record<string, unknown>) => El } };
  new Function("module", "exports", "require", out.outputFiles[0]!.text)(mod, mod.exports, createRequire(import.meta.url));
  return mod.exports.default;
}

function mount(CircleRing: (p: Record<string, unknown>) => El, props: { ring: unknown; round: number }) {
  mini.slots = []; mini.effects = []; frames = []; timers = [];
  let current = props;
  mini.render = () => CircleRing({ ...current, pot: 6n * U });
  rerender();
  return (next: { ring: unknown; round: number }) => { current = next; rerender(); };
}

describe("A5 adversary (594acfe, adapted): the round-change motion after the load-in", () => {
  let CircleRing: (p: Record<string, unknown>) => El;
  before(async () => { CircleRing = await load(); });
  const css = readFileSync(resolve(SRC, "components/robinhood/CircleRing.module.css"), "utf8");
  const ring1 = ringOf(readAt(1), null);
  const ring2 = ringOf(readAt(2), null);
  /** Fire the queued timers in the given order of their delays, re-rendering after each. */
  function fire(order: "on time" | "reversed") {
    const q = [...timers].sort((x, y) => (order === "on time" ? x.at - y.at : y.at - x.at));
    timers = [];
    for (const t of q) { t.cb(); if (dirty) rerender(); }
  }

  it("precondition: only .ready delays the turn until the pot has flown; the entrance spin turns at once", () => {
    assert.match(css, /\.ready \.spin, \.ready \.upright \{ transition: transform \.9s cubic-bezier\(\.2, \.9, \.2, 1\) \.65s; \}/);
    assert.match(css, /\.stSpin \.spin, \.stSpin \.upright \{ transition: transform 1\.4s/);
    assert.equal(ring1.rotation, -120);
    assert.equal(ring2.rotation, -240);
  });

  it("control: the entrance runs in order, ends settled, and a later round change gets the pot-then-turn motion", () => {
    const update = mount(CircleRing, { ring: ring1, round: 1 });
    assert.match(className(mini.tree), /\bstLogo\b/, "the entrance opens as the logo");
    fire("on time");
    assert.match(className(mini.tree), /\bready\b/);
    update({ ring: ring2, round: 2 });
    assert.match(className(mini.tree), /\bready\b/);
  });

  it("timers that arrive out of order (hidden tab, busy main thread): the stage never goes back, the round change still waits for the pot", () => {
    const update = mount(CircleRing, { ring: ring1, round: 1 });
    fire("reversed"); // settled first, then every earlier stage's timer
    assert.match(className(mini.tree), /\bready\b/, `an earlier stage's late timer moved the ring back: "${className(mini.tree)}"`);
    update({ ring: ring2, round: 2 });
    assert.match(className(mini.tree), /\bready\b/,
      `after the load-in, a round change must use the pot-then-turn transition (.ready); the figure's class is "${className(mini.tree)}"`);
  });

  it("entrance off: the ring renders settled at once, no timers", () => {
    mount(CircleRing, { ring: ring1, round: 1, entrance: false } as never);
    assert.match(className(mini.tree), /\bready\b/);
    assert.equal(timers.length, 0);
  });
});
