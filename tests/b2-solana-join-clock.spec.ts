/**
 * PR 2, after adversary r3 on b620e79: Claim your seat judges the price on its own clock, so a split that takes effect
 * while nothing else redraws the page (reads failing, or simply between reads) disables the join by itself, with no
 * new read and no new props. Harness: tests/b2-solana-join-wallet-switch-adversary.spec.ts (a minimal hook runner,
 * one SolanaJoin instance, real timers).
 *
 *   npx mocha --import=tsx --timeout 600000 tests/b2-solana-join-clock.spec.ts     (installs hooks: its own process)
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

describe("PR 2: Claim your seat keeps its own clock", () => {
  it("a split that takes effect with no new read and no new props disables the join by itself", async function () {
    this.timeout(30_000);
    const stockMint = new anchor.web3.PublicKey(mints.nflxxMirror);
    const usdcMint = new anchor.web3.PublicKey(mints.testUsdc);
    const { tokenAccountOf } = await import(pathToFileURL(resolve(SRC, "lib/actions.ts")).href);
    const { minJoinStock } = await import(pathToFileURL(resolve(SRC, "lib/circle.ts")).href);
    const { default: SolanaJoin } = await import(pathToFileURL(JOIN).href);
    const least = minJoinStock(view) as bigint;
    const seat = wallets[1]!;
    const accounts = new Map<string, { data: Uint8Array }>([
      [tokenAccountOf(seat, { stockMint, usdcMint }, "stock").toBase58(), tokenAccount(stockMint, seat, least * 10n)],
      [tokenAccountOf(seat, { stockMint, usdcMint }, "usdc").toBase58(), tokenAccount(usdcMint, seat, BigInt(view.guaranteePerMember))],
    ]);
    const connection = { getAccountInfo: async (k: anchor.web3.PublicKey) => accounts.get(k.toBase58()) ?? null, getBalance: async () => 1_000_000_000, getMinimumBalanceForRentExemption: async (space: number) => (space + 128) * 6960 };
    // real timers for the row's clock
    const timers: ReturnType<typeof setInterval>[] = [];
    g.window = { setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); timers.push(id); return id; }, clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id) };
    try {
      const start = Math.floor(Date.now() / 1000);
      // the feed is priced for x1; a 10-for-1 takes effect 2 s from now
      const split = { multiplier: 1, newMultiplier: 10, effectiveAt: start + 2 };
      const usdc = (b: bigint) => `${(Number(b) / 1e6).toFixed(2)} test USDC`;
      const props = { c: view, split, owner: seat, mints: { stockMint, usdcMint }, vaults: { stock: anchor.web3.Keypair.generate().publicKey, usdc: anchor.web3.Keypair.generate().publicKey }, connection, blocked: null, readAt: start, words: { stock: "NFLXx devnet mirror", stockShort: "NFLXx mirror", usdc }, onJoin: () => {} };
      mini.slots.length = 0;
      mini.effects.length = 0;
      mini.render = () => SolanaJoin(props);
      rerender();
      await settle();
      assert.equal(joinButton()!.props.disabled, false, "precondition: before the split, the seat can join");
      // let the split take effect; nothing else changes (no read, no props)
      while (Math.floor(Date.now() / 1000) < split.effectiveAt + 1) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1100));
      await settle();
      assert.equal(joinButton()!.props.disabled, true, `the join is still enabled after the split took effect: ${text(mini.tree).slice(0, 300)}`);
      assert.match(text(mini.tree), /joining waits for a price set for the new multiplier/);
    } finally {
      for (const id of timers) clearInterval(id);
      for (const ef of mini.effects) ef.cleanup?.();
    }
  });
});
