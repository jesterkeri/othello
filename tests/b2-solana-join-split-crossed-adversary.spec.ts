/**
 * B2 adversary on 16ea294: "Claim your seat" offers a join that join_and_lock refuses, by what the page already knows.
 *
 *   Spec 1 (PR 2 brief): the join "is enabled only when nothing the page can know would make join_and_lock refuse
 *   (... a fresh price set for the multiplier in force ...); otherwise it says why". Its amount "is prefilled with the
 *   least stock the program accepts (join_and_lock's CollateralBelowMinimum rule, exactly)".
 *
 * 1. A split that takes effect between the read and the moment the page is drawn. join_and_lock values the stock with
 *    value_position (programs/othello/src/valuation.rs), which decodes the mint's multiplier at the chain's clock
 *    (effective_multiplier_bits(&config, now)) and refuses MultiplierPriceMismatch unless the feed was priced for it.
 *    The page gates the join on `repricing`, which compares the feed's stamp with view.effectiveMultiplier, the
 *    multiplier at the READ's time (lib/live.ts decodeLive: multiplierAt(scaled, now)). The page also holds the split
 *    schedule (live.split) and the wall clock, and already uses them: SolanaPanel is given multiplierAt(live.split,
 *    Date.now()) and the top line drops "Split scheduled" once effectiveAt <= wallClock. A read is routinely several
 *    seconds old when drawn (the page polls every 5 s and /api/circle serves a read for 4 s), and the last good read
 *    stays on screen for as long as reads fail. Fixture: the demo circle's Forming state (app/src/fixtures/circles.ts)
 *    and the real NFLXx 10-for-1 (SPEC 9b.1: x1 to x10), with the feed still priced for x1.
 *
 * 2. A circle whose min_stock_cover is 0 (create_circle allows it when the guarantees meet the peak need on their own;
 *    tests/a7-circle-page-closeout-zero-stock-adversary.spec.ts covers a seat that joined with stock_raw 0). The least
 *    stock join_and_lock accepts is then 0 (valuation.h = 0 >= 0), and minJoinStock says so, but SolanaJoin prefills
 *    an empty field and parseUnits never yields 0, so the join at the least amount can never be sent.
 *
 * Harness: the minimal hook runner of tests/b2-solana-join-wallet-switch-adversary.spec.ts (LiveCircle once, to take
 * the SolanaJoin element it draws; then SolanaJoin itself with those props, effects run).
 *
 *   npx mocha --import=tsx --timeout 600000 tests/b2-solana-join-split-crossed-adversary.spec.ts     (installs hooks: its own process)
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
  // as React does, the key is lifted out of the props (the page is compiled with classic createElement)
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
    const { key, ...rest } = props ?? {};
    return { type, props: { ...rest, children: children.length <= 1 ? children[0] : children }, key } as El;
  },
  Fragment: "fragment",
};
// the key is kept: it decides whether React keeps a child's state across renders
const jsx = (type: unknown, props: Record<string, unknown>, key?: unknown) => ({ type, props, key });

// ---------------------------------------------------------------- the I/O the page touches, driven by the test
const g = globalThis as Record<string, unknown>;
g.__mini = ReactStub;
g.__jsx = jsx;
g.React = ReactStub;
g.window = { setInterval: () => 0, clearInterval: () => {} };

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
// forming: seat 1 (the creator) has joined, seats 2 to 5 have not; price fresh and set for the multiplier in force
const view: CircleView = {
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

/** An SPL / Token-2022 token account's bytes as the RPC returns them: mint, owner, then the u64 amount at 64. */
function tokenAccount(mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, amount: bigint): { data: Uint8Array } {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b[108] = 1; // AccountState::Initialized
  return { data: new Uint8Array(b) };
}


async function drawJoin(view: CircleView, opts: { readAt: number; split: { multiplier: number; newMultiplier: number; effectiveAt: number } }) {
  const stockMint = new anchor.web3.PublicKey(mints.nflxxMirror);
  const usdcMint = new anchor.web3.PublicKey(mints.testUsdc);
  const { tokenAccountOf } = await import(pathToFileURL(resolve(SRC, "lib/actions.ts")).href);
  const me = wallets[1]!;
  // seat 2's wallet holds plenty of the stock and the guarantee: nothing about its balances refuses the join
  const accounts = new Map<string, { data: Uint8Array }>([
    [tokenAccountOf(me, { stockMint, usdcMint }, "stock").toBase58(), tokenAccount(stockMint, me, 1_000_000_000_000n)],
    [tokenAccountOf(me, { stockMint, usdcMint }, "usdc").toBase58(), tokenAccount(usdcMint, me, BigInt(view.guaranteePerMember))],
  ]);
  g.__conn = { getAccountInfo: async (k: anchor.web3.PublicKey) => accounts.get(k.toBase58()) ?? null, getBalance: async () => 1_000_000_000, getMinimumBalanceForRentExemption: async (space: number) => (space + 128) * 6960 };
  const CIRCLE = anchor.web3.Keypair.generate().publicKey.toBase58();
  const live = { view, accounts: { circle: CIRCLE, usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror }, split: opts.split, pool: { discountBps: 2000, usdc: 1_000_000_000 }, readAt: opts.readAt };
  g.fetch = async () => ({ json: async () => live });

  mini.slots.length = 0;
  mini.effects.length = 0;
  const page = await import(pathToFileURL(PAGE).href);
  const { default: SolanaJoin } = await import(pathToFileURL(JOIN).href);
  const { default: SolanaPanel } = await import(pathToFileURL(resolve(SRC, "components/live/SolanaPanel.tsx")).href);
  mini.render = () => page.default({ address: CIRCLE });
  g.__wallet = { publicKey: me, sendTransaction: async () => "x" };
  rerender();
  await settle();
  const el = find(mini.tree, (e) => e.type === SolanaJoin);
  assert.ok(el, "precondition: seat 2's wallet is offered Claim your seat");
  const panel = find(mini.tree, (e) => e.type === SolanaPanel);

  mini.slots.length = 0;
  mini.effects.length = 0;
  mini.render = () => SolanaJoin(el.props);
  rerender();
  await settle();
  return { button: joinButton()!, input: find(mini.tree, (e) => e.type === "input")!, text: text(mini.tree), panel };
}

describe("B2 adversary: Claim your seat offers a join join_and_lock refuses", () => {
  it("a split that took effect after the read: the join waits for a price set for the new multiplier", async () => {
    // read 8 s ago, under x1 (the feed's own stamp); the 10-for-1 took effect 3 s ago and nobody has repriced yet
    const readAt = NOW - 8;
    const split = { multiplier: 1, newMultiplier: 10, effectiveAt: NOW - 3 };
    const { button, text: said, panel } = await drawJoin(view, { readAt, split });
    // the page knows the multiplier in force now: it hands x10 to its own mirror panel
    assert.equal((panel!.props.mirror as { multiplierNow: number }).multiplierNow, 10, "precondition: the page draws the mirror at x10 now");
    assert.equal(view.feed.pricedForMultiplier, 1_000_000_000, "precondition: the feed is priced for x1 only");
    assert.equal(button.props.disabled, true, `Join is enabled although the chain now values the stock at x10 and the feed is priced for x1 (MultiplierPriceMismatch). The page said: ${said.slice(0, 400)}`);
  });

  it("min_stock_cover 0: the field is prefilled with the least the program accepts, 0, and that join can be sent", async () => {
    const { minJoinStock } = await import(pathToFileURL(resolve(SRC, "lib/circle.ts")).href);
    const zero: CircleView = { ...view, minStockCover: 0 };
    assert.equal(minJoinStock(zero), 0n, "precondition: the least stock join_and_lock accepts here is 0");
    const { input, button, text: said } = await drawJoin(zero, { readAt: NOW, split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 } });
    assert.equal(input.props.value, "0", `the amount is not prefilled with the least (0); the page said: ${said.slice(0, 400)}`);
    assert.equal(button.props.disabled, false, "the join at the least amount cannot be sent");
  });
});
