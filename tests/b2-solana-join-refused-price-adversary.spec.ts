/**
 * B2 adversary on b620e79: "Claim your seat" still names, and still offers, a join at a price the program refuses.
 *
 *   Spec 1 (PR 2 brief): the amount "is prefilled with the least stock the program accepts (join_and_lock's
 *   CollateralBelowMinimum rule, exactly, at the multiplier in force when it is sent) ...; it names what the amount
 *   counts as in cover, and names no figure from a price the program would refuse. It is enabled only when nothing the
 *   page can know would make join_and_lock refuse (... a fresh price set for the multiplier in force now ...)".
 *
 * 1. A stale price. join_and_lock refuses PriceStale (valuation.rs value_position: age <= max_price_age), so there is
 *    no least the program accepts. SolanaJoin hides its two sentences while `blocked`, but still prefills the input
 *    with minJoinStock at that stale price and names it on the button ("Join: lock 1 NFLXx mirror ..."). The same
 *    holds for a price set for another multiplier (repricing).
 *
 * 2. The split crossing with no re-render. b620e79 judges "the multiplier in force now" by Date.now() at render
 *    time, but nothing renders the page when the split takes effect. While the reads fail with the route's constant
 *    "devnet RPC unreachable or rate-limited" (app/src/app/api/circle/route.ts), setError gets the same string each
 *    time and React bails out, so the last render (the first failure's, drawn before effectiveAt) stays: Join
 *    enabled, the cover figure at x1, after the 10-for-1 has taken effect and the feed is priced for x1 only
 *    (MultiplierPriceMismatch). Real time and real timers (the page's own 5 s refresh included), so any re-render the
 *    page schedules is seen.
 *
 * Harness: the minimal hook runner of tests/b2-solana-join-split-crossed-adversary.spec.ts. Fixture: the demo circle's
 * Forming state (app/src/fixtures/circles.ts), the NFLXx 10-for-1 of SPEC 9b.1 (x1 to x10).
 *
 *   npx mocha --import=tsx --timeout 600000 tests/b2-solana-join-refused-price-adversary.spec.ts     (installs hooks: its own process)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

import { REPO } from "./artifacts.ts";
import { CIRCLE_STATES } from "../app/src/fixtures/circles.ts";
import type { CircleView } from "../app/src/lib/circle.ts";

const SRC = resolve(REPO, "app/src");
const JOIN = resolve(SRC, "components/live/SolanaJoin.tsx");
const PAGE = resolve(SRC, "components/live/LiveCircle.tsx");

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
  lastRenderAt: 0,
};
const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
function rerender() {
  mini.scheduled = false;
  mini.i = 0;
  mini.e = 0;
  mini.lastRenderAt = Date.now();
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
      // as React does: setting the same value does not render again
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
  // as React does, the key is lifted out of the props (the page is compiled with classic createElement)
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
    const { key, ...rest } = props ?? {};
    return { type, props: { ...rest, children: children.length <= 1 ? children[0] : children }, key } as El;
  },
  Fragment: "fragment",
};
const jsx = (type: unknown, props: Record<string, unknown>, key?: unknown) => ({ type, props, key });

// ---------------------------------------------------------------- the I/O the page touches, driven by the test
const g = globalThis as Record<string, unknown>;
g.__mini = ReactStub;
g.__jsx = jsx;
g.React = ReactStub;
// real timers: whatever the page schedules (its 5 s refresh, or any clock it keeps) really runs
const timers = new Set<ReturnType<typeof setInterval>>();
g.window = {
  setInterval: (fn: () => void, ms: number) => {
    const id = setInterval(fn, ms);
    timers.add(id);
    return id;
  },
  clearInterval: (id: ReturnType<typeof setInterval>) => {
    clearInterval(id);
    timers.delete(id);
  },
  setTimeout: (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timers.add(id);
    return id;
  },
  clearTimeout: (id: ReturnType<typeof setTimeout>) => {
    clearTimeout(id);
    timers.delete(id);
  },
};

const STUBS: Record<string, string> = {
  react: `const m = globalThis.__mini; export default m; export const { useState, useRef, useMemo, useCallback, useEffect, createElement, Fragment } = m;`,
  "react/jsx-runtime": `export const jsx = globalThis.__jsx, jsxs = globalThis.__jsx, Fragment = "fragment";`,
  "react/jsx-dev-runtime": `export const jsxDEV = globalThis.__jsx, Fragment = "fragment";`,
  "@/components/othello/Shell": `export default function Shell() { return null; }`,
  "@/lib/active-side": `export function useActiveSide() { return { side: 'solana', connected: { evm: false, solana: true } }; } export function showsChainSwitch() { return false; }`,
  "@/components/othello/WalletConnect": `export function WalletControl() { return null; }`,
  "@solana/wallet-adapter-react": `export function useConnection() { return { connection: globalThis.__conn }; } export function useWallet() { return globalThis.__wallet; }`,
};

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier in STUBS) return stub(STUBS[specifier]!);
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
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
  const inner = e.props ? [e.props.children, ...Object.entries(e.props).filter(([k, v]) => k !== "children" && v && typeof v === "object").map(([, v]) => v)] : Object.values(e);
  for (const x of inner) {
    const hit = find(x, pred);
    if (hit) return hit;
  }
  return null;
}
const text = (el: unknown): string =>
  el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el)
    : Array.isArray(el) ? el.map(text).join("")
    : (el as El).props ? [(el as El).props.children, ...Object.entries((el as El).props).filter(([k, v]) => k !== "children" && v && typeof v === "object").map(([, v]) => v)].map(text).join(" ")
    : typeof el === "object" ? Object.values(el as object).map(text).join(" ") : "";
const settle = async () => {
  for (let k = 0; k < 30; k++) await new Promise((r) => setTimeout(r, 0));
};
// the join button: "Join: lock ..." when an amount can be named, plain "Join" otherwise (since the fix for b620e79)
const joinButton = () => find(mini.tree, (e) => e.type === "button" && /^Join(: lock|$)/.test(text(e.props.children)));

const mints = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const NOW = Math.floor(Date.now() / 1000);
const A = CIRCLE_STATES.active;
const wallets = A.members.map(() => anchor.web3.Keypair.generate().publicKey);
// forming: seat 1 (the creator) has joined, seats 2 to 5 have not; the feed priced for x1, fresh unless a test says not
const forming: CircleView = {
  ...A,
  members: A.members.map((m, i) => ({ ...m, address: wallets[i]!.toBase58() })),
  creator: wallets[0]!.toBase58(),
  status: "Forming",
  round: 0,
  paidBitmap: 0,
  receivedBitmap: 0,
  defaultedBitmap: 0,
  joinedBitmap: 0b00001,
  nextGateShortBy: 0,
  feed: { ...A.feed, updatedAt: NOW - 30 },
};
type Split = { multiplier: number; newMultiplier: number; effectiveAt: number };

/** An SPL / Token-2022 token account's bytes as the RPC returns them: mint, owner, then the u64 amount at 64. */
function tokenAccount(mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, amount: bigint): { data: Uint8Array } {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b[108] = 1; // AccountState::Initialized
  return { data: new Uint8Array(b) };
}

/** Seat 2's wallet holds plenty of the stock and the guarantee: nothing about its balances refuses the join. */
async function wire(view: CircleView) {
  const stockMint = new anchor.web3.PublicKey(mints.nflxxMirror);
  const usdcMint = new anchor.web3.PublicKey(mints.testUsdc);
  const { tokenAccountOf } = await import(pathToFileURL(resolve(SRC, "lib/actions.ts")).href);
  const me = wallets[1]!;
  const accounts = new Map<string, { data: Uint8Array }>([
    [tokenAccountOf(me, { stockMint, usdcMint }, "stock").toBase58(), tokenAccount(stockMint, me, 1_000_000_000_000n)],
    [tokenAccountOf(me, { stockMint, usdcMint }, "usdc").toBase58(), tokenAccount(usdcMint, me, BigInt(view.guaranteePerMember))],
  ]);
  g.__conn = { getAccountInfo: async (k: anchor.web3.PublicKey) => accounts.get(k.toBase58()) ?? null, getBalance: async () => 1_000_000_000, getMinimumBalanceForRentExemption: async (space: number) => (space + 128) * 6960 };
  g.__wallet = { publicKey: me, sendTransaction: async () => "x" };
}

/** SolanaJoin as the DOM shows it for these props: rendered, effects (the balance read) run. */
async function drawJoinFrom(props: Record<string, unknown>) {
  const { default: SolanaJoin } = await import(pathToFileURL(JOIN).href);
  mini.slots.length = 0;
  mini.effects.length = 0;
  mini.render = () => SolanaJoin(props);
  rerender();
  await settle();
  return { button: joinButton()!, input: find(mini.tree, (e) => e.type === "input")!, text: text(mini.tree) };
}

async function joinElementOf(view: CircleView, split: Split, readAt: number) {
  await wire(view);
  const CIRCLE = anchor.web3.Keypair.generate().publicKey.toBase58();
  const live = { view, accounts: { circle: CIRCLE, usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror }, split, pool: { discountBps: 2000, usdc: 1_000_000_000 }, readAt };
  g.fetch = async () => ({ json: async () => live });
  const page = await import(pathToFileURL(PAGE).href);
  const { default: SolanaJoin } = await import(pathToFileURL(JOIN).href);
  mini.slots.length = 0;
  mini.effects.length = 0;
  mini.render = () => page.default({ address: CIRCLE });
  rerender();
  await settle();
  const el = find(mini.tree, (e) => e.type === SolanaJoin);
  assert.ok(el, "precondition: seat 2's wallet is offered Claim your seat");
  // unmount the page (its refresh interval) before the next draw
  for (const ef of mini.effects) ef.cleanup?.();
  return el;
}

describe("B2 adversary: Claim your seat at a price the program refuses", () => {
  afterEach(() => {
    for (const id of timers) clearInterval(id);
    timers.clear();
  });

  it("a stale price: the amount and the button name no least stock computed from it", async () => {
    const { minJoinStock } = await import(pathToFileURL(resolve(SRC, "lib/circle.ts")).href);
    const { unitsText } = await import(pathToFileURL(resolve(SRC, "lib/actions.ts")).href);
    // priced 60 s past max_price_age: join_and_lock refuses PriceStale, whatever the amount
    const stale: CircleView = { ...forming, feed: { ...forming.feed, updatedAt: NOW - forming.maxPriceAge - 60 } };
    const el = await joinElementOf(stale, { multiplier: 1, newMultiplier: 1, effectiveAt: 0 }, NOW);
    const fromStale = unitsText(minJoinStock(stale) as bigint, 8);
    const { button, input, text: said } = await drawJoinFrom(el.props);
    // since the fix for b620e79 the join row judges the price on its own clock, so the precondition reads what it draws
    assert.match(said, /old, and joining needs a fresh one/, "precondition: the page knows the price is stale");
    assert.equal(button.props.disabled, true, "precondition: the join is disabled");
    const label = text(button.props.children);
    assert.ok(
      input.props.value !== fromStale && !label.includes(`lock ${fromStale} `),
      `the least at the stale price (${fromStale}) is still named: input "${String(input.props.value)}", button "${label}". The page said: ${said.slice(0, 300)}`,
    );
  });

  it("the split takes effect while the reads fail: Join is no longer enabled once x10 is in force", async () => {
    await wire(forming);
    const CIRCLE = anchor.web3.Keypair.generate().publicKey.toBase58();
    const t0 = Math.floor(Date.now() / 1000);
    // the 10-for-1 takes effect 7 s from now, after the page's first refresh (at 5 s) has failed and been drawn;
    // the feed is priced for x1 and fresh
    const split: Split = { multiplier: 1, newMultiplier: 10, effectiveAt: t0 + 7 };
    const live = { view: { ...forming, feed: { ...forming.feed, updatedAt: t0 - 5 } }, accounts: { circle: CIRCLE, usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror }, split, pool: { discountBps: 2000, usdc: 1_000_000_000 }, readAt: t0 };
    // the first read succeeds; every read after it fails with the route's own constant words
    let reads = 0;
    g.fetch = async () => { console.log("fetch", Date.now() / 1000 - t0); return { json: async () => (++reads === 1 ? live : { error: "devnet RPC unreachable or rate-limited" }) }; };
    const page = await import(pathToFileURL(PAGE).href);
    const { default: SolanaJoin } = await import(pathToFileURL(JOIN).href);
    mini.slots.length = 0;
    mini.effects.length = 0;
    mini.render = () => page.default({ address: CIRCLE });
    rerender();
    await settle();
    const before = find(mini.tree, (e) => e.type === SolanaJoin);
    assert.ok(before && before.props.blocked === null, "precondition: before the split, Claim your seat is drawn with nothing blocking it");

    // wait until the split has been in force for 4 s (past the page's second refresh at 10 s, which fails too)
    while (Math.floor(Date.now() / 1000) < split.effectiveAt + 4) await new Promise((r) => setTimeout(r, 100));
    await settle();
    assert.ok(reads >= 3, `precondition: the page's refresh ran twice more and failed (${reads} reads)`);
    assert.ok(text(mini.tree).includes("devnet RPC unreachable or rate-limited"), "precondition: the page shows the failed read");
    const after = find(mini.tree, (e) => e.type === SolanaJoin);
    const lastDrawn = mini.lastRenderAt / 1000 - split.effectiveAt;
    for (const ef of mini.effects) ef.cleanup?.();
    assert.ok(after, "precondition: Claim your seat is still drawn");
    const { button, text: said } = await drawJoinFrom(after.props);
    assert.equal(
      button.props.disabled,
      true,
      `Join is still enabled ${Math.floor(Date.now() / 1000) - split.effectiveAt} s after the 10-for-1 took effect, with the feed priced for x1 (MultiplierPriceMismatch); the page last rendered ${lastDrawn.toFixed(1)} s from it. It says: ${said.slice(0, 400)}`,
    );
  });
});
