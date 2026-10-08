/**
 * B2 adversary on 6587a2b: "Claim your seat" draws the previous wallet's balances for the newly connected wallet.
 *
 *   Spec 5 (PR 2 brief): "nothing read for an earlier address or wallet is drawn".
 *   Spec 1: the join "is enabled only when nothing the page can know would make join_and_lock refuse (the amount, the
 *   wallet's stock account and balance, its test USDC for the guarantee ...); otherwise it says why".
 *
 * SolanaJoin (components/live/SolanaJoin.tsx) keeps the balances it read in one state slot and clears it to "reading"
 * only inside its useEffect, keyed on the owner. LiveCircle renders it at the same place for any seat that has not
 * joined, so when the visitor switches from one unjoined seat's wallet to another's, the component is not remounted:
 * the first render (and commit) for the new wallet still uses the old wallet's balances. Wallet A holds the stock and
 * the guarantee; wallet B has no stock account at all (join_and_lock refuses it: member_stock_ata must exist). The
 * first render for B draws "Join" enabled, with A's balances behind it, until the effect runs.
 *
 * Harness: the minimal hook runner of tests/a7-circle-page-wallet-switch-adversary.spec.ts. It runs one component, so
 * the test runs it twice: first LiveCircle, for each wallet, to take the SolanaJoin element it draws (its type, key and
 * props: if they keep the same identity, React keeps SolanaJoin's state); then SolanaJoin itself with those props
 * (render, then effects, as React does: a render is committed before its effects run).
 * The connection is a local stub; token accounts are the SPL account layout (amount at bytes 64..72), built here.
 *
 *   npx mocha --import=tsx --timeout 600000 tests/b2-solana-join-wallet-switch-adversary.spec.ts     (installs hooks: its own process)
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
const joinButton = () => find(mini.tree, (e) => e.type === "button" && /^Join: lock/.test(text(e.props.children)));

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

describe("B2 adversary: Claim your seat never draws the previous wallet's balances", () => {
  it("switching from seat 2's wallet (holds everything) to seat 3's (no stock account) never draws Join enabled for seat 3", async () => {
    const stockMint = new anchor.web3.PublicKey(mints.nflxxMirror);
    const usdcMint = new anchor.web3.PublicKey(mints.testUsdc);
    const { tokenAccountOf } = await import(pathToFileURL(resolve(SRC, "lib/actions.ts")).href);
    const { minJoinStock } = await import(pathToFileURL(resolve(SRC, "lib/circle.ts")).href);
    const least = minJoinStock(view) as bigint;
    const rich = wallets[1]!;
    const empty = wallets[2]!;
    // seat 2's wallet holds ten times the least stock and the guarantee; seat 3's wallet has no token accounts at all
    const accounts = new Map<string, { data: Uint8Array }>([
      [tokenAccountOf(rich, { stockMint, usdcMint }, "stock").toBase58(), tokenAccount(stockMint, rich, least * 10n)],
      [tokenAccountOf(rich, { stockMint, usdcMint }, "usdc").toBase58(), tokenAccount(usdcMint, rich, BigInt(view.guaranteePerMember))],
    ]);
    g.__conn = { getAccountInfo: async (k: anchor.web3.PublicKey) => accounts.get(k.toBase58()) ?? null };
    const CIRCLE = anchor.web3.Keypair.generate().publicKey.toBase58();
    const live = { view, accounts: { circle: CIRCLE, usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror }, split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 }, pool: { discountBps: 2000, usdc: 1_000_000_000 }, readAt: NOW };
    g.fetch = async () => ({ json: async () => live });

    // 1. LiveCircle, as seat 2's wallet and then seat 3's: the SolanaJoin element it draws for each
    const page = await import(pathToFileURL(PAGE).href);
    const { default: SolanaJoin } = await import(pathToFileURL(JOIN).href);
    const joinEl = () => find(mini.tree, (e) => e.type === SolanaJoin) as (El & { key?: unknown }) | null;
    mini.render = () => page.default({ address: CIRCLE });
    g.__wallet = { publicKey: rich, sendTransaction: async () => "x" };
    rerender();
    await settle();
    const forRich = joinEl();
    assert.ok(forRich, "precondition: seat 2's wallet is offered Claim your seat");
    g.__wallet = { publicKey: empty, sendTransaction: async () => "x" };
    rerender();
    await settle();
    const forEmpty = joinEl();
    assert.ok(forEmpty, "precondition: seat 3's wallet is offered Claim your seat");
    // a page that gives each wallet its own SolanaJoin (a key per wallet) starts it afresh: nothing to lose here
    if (forRich.key !== forEmpty.key) return;

    // 2. SolanaJoin with those props, its state kept across the switch as React keeps it
    mini.slots.length = 0;
    mini.effects.length = 0;
    let props = forRich.props;
    mini.render = () => SolanaJoin(props);
    rerender();
    await settle();
    assert.equal(joinButton()!.props.disabled, false, "precondition: seat 2's wallet can join");

    props = forEmpty.props;
    rerender(); // React commits this render before its effects run
    const first = { disabled: joinButton()!.props.disabled };
    await settle();
    assert.equal(joinButton()!.props.disabled, true, "precondition: once read, seat 3's wallet cannot join (no stock account)");
    assert.match(text(mini.tree), /no NFLXx devnet mirror account/);

    assert.equal(first.disabled, true, "the first render for seat 3's wallet drew Join enabled, from seat 2's wallet's balances");
  });
});
