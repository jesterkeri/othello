/**
 * B2 adversary on e7959b0: on a device whose clock runs behind, Claim your seat stops judging the price after the read.
 *
 *   Spec 1 (PR 2 brief): "It is enabled only when nothing the page can know would make join_and_lock refuse (...
 *   a fresh price set for the multiplier in force now, judged continuously and never earlier than the read ...)".
 *
 * e7959b0 judges the price at max(device clock, readAt) (SolanaJoin.tsx: `const at = Math.max(now, readAt)`). On a
 * device clock that runs behind, `at` is pinned to readAt: the row's own one-second clock ticks, but every tick lands
 * on the read's time again. While reads keep failing (LiveCircle keeps the last `live`, so readAt never moves) the
 * price never ages on this row, and Join stays enabled, naming a least and a cover figure, after join_and_lock refuses
 * PriceStale (valuation.rs value_position: now - updated_at > max_price_age). The page can know time has passed: its
 * own clock has advanced since it received the read, whatever its offset.
 *
 * Input: the device clock one hour behind; the feed fresh at readAt and stale two seconds later; no new read. The test
 * waits four real seconds, so a fix measured on Date.now or on performance.now both see the time pass.
 *
 * Harness: the minimal hook runner of tests/b2-solana-join-device-clock-adversary.spec.ts (one SolanaJoin instance),
 * with the row's interval ticking in real time. Fixture: the demo circle's state (app/src/fixtures/circles.ts) made
 * Forming, with seat 2 open.
 *
 *   npx mocha --import=tsx --timeout 600000 tests/b2-solana-join-behind-clock-frozen-adversary.spec.ts     (installs hooks: its own process)
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
    const { key, ...rest } = props ?? {};
    return { type, props: { ...rest, children: children.length <= 1 ? children[0] : children }, key } as El;
  },
  Fragment: "fragment",
};
const jsx = (type: unknown, props: Record<string, unknown>, key?: unknown) => ({ type, props, key });

// ---------------------------------------------------------------- the I/O the row touches, driven by the test
const g = globalThis as Record<string, unknown>;
g.__mini = ReactStub;
g.__jsx = jsx;
g.React = ReactStub;
// the row's own one-second clock, ticking in real time
g.window = { setInterval: (fn: () => void, ms: number) => setInterval(fn, ms), clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id) };

const STUBS: Record<string, string> = {
  react: `const m = globalThis.__mini; export default m; export const { useState, useRef, useMemo, useCallback, useEffect, createElement, Fragment } = m;`,
  "react/jsx-runtime": `export const jsx = globalThis.__jsx, jsxs = globalThis.__jsx, Fragment = "fragment";`,
  "react/jsx-dev-runtime": `export const jsxDEV = globalThis.__jsx, Fragment = "fragment";`,
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
// the read's own time, and the device's clock one hour behind it
const READ_AT = Math.floor(Date.now() / 1000);
const BEHIND_S = 3600;
const A = CIRCLE_STATES.active;
const wallets = A.members.map(() => anchor.web3.Keypair.generate().publicKey);
// forming: seat 1 has joined, seats 2 to 5 have not; the price is set for the multiplier in force (x1, no split), is
// fresh at the read (age max_price_age - 1) and stale two seconds after it
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
  feed: { ...A.feed, updatedAt: READ_AT - A.maxPriceAge + 1 },
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

describe("B2 adversary on e7959b0: a device clock behind, and no new read", () => {
  it("disables Join once the price has aged past max_price_age since the read", async function () {
    this.timeout(30_000);
    const stockMint = new anchor.web3.PublicKey(mints.nflxxMirror);
    const usdcMint = new anchor.web3.PublicKey(mints.testUsdc);
    const { tokenAccountOf } = await import(pathToFileURL(resolve(SRC, "lib/actions.ts")).href);
    const { isStale, minJoinStock } = await import(pathToFileURL(resolve(SRC, "lib/circle.ts")).href);
    const { default: SolanaJoin } = await import(pathToFileURL(JOIN).href);
    assert.equal(isStale(view, READ_AT), false, "precondition: the price is fresh at the read");
    const least = minJoinStock(view) as bigint;
    const seat = wallets[1]!;
    // the wallet holds everything else the join needs: ten times the least, the guarantee, 1 SOL
    const accounts = new Map<string, { data: Uint8Array }>([
      [tokenAccountOf(seat, { stockMint, usdcMint }, "stock").toBase58(), tokenAccount(stockMint, seat, least * 10n)],
      [tokenAccountOf(seat, { stockMint, usdcMint }, "usdc").toBase58(), tokenAccount(usdcMint, seat, BigInt(view.guaranteePerMember))],
    ]);
    const connection = { getAccountInfo: async (k: anchor.web3.PublicKey) => accounts.get(k.toBase58()) ?? null, getBalance: async () => 1_000_000_000, getMinimumBalanceForRentExemption: async (space: number) => (space + 128) * 6960 };
    const realNow = Date.now;
    Date.now = () => realNow() - BEHIND_S * 1000;
    try {
      const usdc = (b: bigint) => `${(Number(b) / 1e6).toFixed(2)} test USDC`;
      // the same props for the whole test: the reads after this one keep failing, so readAt never moves
      const props = { c: view, split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 }, owner: seat, mints: { stockMint, usdcMint }, vaults: { stock: anchor.web3.Keypair.generate().publicKey, usdc: anchor.web3.Keypair.generate().publicKey }, connection, blocked: null, readAt: READ_AT, words: { stock: "NFLXx devnet mirror", stockShort: "NFLXx mirror", usdc }, onJoin: () => {} };
      mini.slots.length = 0;
      mini.effects.length = 0;
      mini.render = () => SolanaJoin(props);
      rerender();
      await settle();
      assert.equal(joinButton()!.props.disabled, false, "precondition: Join is enabled while the price is fresh");
      // four real seconds: the chain's clock is now past updated_at + max_price_age (join_and_lock: PriceStale)
      // (waits on the real clock until the price is past max_price_age by a second, then one more tick of the row's
      // clock: a fixed four-second sleep was flaky)
      while (Math.floor(realNow() / 1000) < view.feed.updatedAt + view.maxPriceAge + 2) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1_100));
      await settle();
      assert.equal(isStale(view, Math.floor(realNow() / 1000)), true, "precondition: the price is now stale on the chain's clock");
      const button = joinButton()!;
      assert.equal(button.props.disabled, true, `Join is enabled with a price the program refuses as stale: "${text(button.props.children)}"`);
    } finally {
      Date.now = realNow;
      for (const ef of mini.effects) ef.cleanup?.();
    }
  });
});
