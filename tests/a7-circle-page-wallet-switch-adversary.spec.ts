/**
 * A7 adversary, fifth pass: the shared single-circle page on a Solana circle (PR #27, 8e069e5), against its spec.
 *
 *   Spec 2: "every action's outcome (done, declined, refused, unconfirmed) shows to the wallet that sent it, in the
 *   round it applies to, with its transaction where one was sent, and nowhere after; an action in flight is always
 *   shown to its sender".
 *
 * The page follows ONE transaction (LiveCircle.tsx `payState`). 8e069e5 hides it from any other connected wallet
 * (`pay` reads idle when `payState.by !== you`), and `busy` / `canSend` are computed from that filtered `pay`. So a
 * second wallet connected while the first wallet's transaction is still confirming sees every button enabled and can
 * send its own transaction; both `send` calls then write the one `payState`. When the first wallet's confirmation
 * lands, `setPay({ phase: "done", by: A })` overwrites the second wallet's in-flight state, and the second wallet's
 * transaction, sent and still confirming on devnet, is shown nowhere to the wallet that sent it.
 *
 * Sequence (round 1, nobody has paid): seat 1's wallet presses "Pay"; the wallet returns its signature and the page
 * waits for devnet. The visitor switches the wallet to seat 2 (one browser, two accounts). Seat 2 presses "Pay"; its
 * wallet returns its signature, devnet has not confirmed it yet. Seat 1's confirmation lands. Seat 2 is still
 * connected and its payment is still in flight.
 *
 * Harness: the minimal hook runner of tests/a5-release-race-attribution.spec.ts, so `send` really runs; the wallet,
 * the connection and fetch are driven by the test. No network: getLatestBlockhash, sendTransaction and
 * confirmTransaction are local stubs; contributeIx is the repo's own instruction builder (no I/O).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-wallet-switch-adversary.spec.ts     (installs hooks: its own process)
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
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  Fragment: "fragment",
};
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });

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
const payButton = () => find(mini.tree, (e) => e.type === "button" && /^Pay /.test(text(e.props.children)));

// ---------------------------------------------------------------- chain state: round 1 of 5, nobody has paid
const mints = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const NOW = Math.floor(Date.now() / 1000);
const A = CIRCLE_STATES.active;
const wallets = A.members.map(() => anchor.web3.Keypair.generate().publicKey);
const CIRCLE = anchor.web3.Keypair.generate().publicKey.toBase58();
const view: CircleView = {
  ...A,
  members: A.members.map((m, i) => ({ ...m, address: wallets[i]!.toBase58() })),
  status: "Active",
  round: 0,
  paidBitmap: 0,
  receivedBitmap: 0,
  defaultedBitmap: 0,
  nextGateShortBy: 0,
  roundDeadline: NOW + 600,
  feed: { ...A.feed, updatedAt: NOW - 30 },
};
const live = {
  view,
  accounts: { circle: CIRCLE, usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
  split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
  pool: { discountBps: 2000, usdc: 1_000_000_000 },
  readAt: NOW,
};
g.fetch = async () => ({ json: async () => live });

const SIG_A = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const SIG_B = "5tHkNX2tVoIaTyHtqviqrMEy7xjzkOuAZNeM5WAIjsBo";
const confirms = new Map<string, (v: unknown) => void>();
g.__conn = {
  getLatestBlockhash: async () => ({ blockhash: anchor.web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
  confirmTransaction: ({ signature }: { signature: string }) => new Promise((r) => confirms.set(signature, r)),
  getTransaction: async () => null,
};
const walletOf = (pk: anchor.web3.PublicKey, sig: string) => ({ publicKey: pk, sendTransaction: async () => sig });

describe("A7 adversary: a second wallet's payment in flight is shown to it after the first wallet's lands", () => {
  it("seat 2's payment, sent and still confirming, stays on screen for seat 2 when seat 1's payment confirms", async () => {
    const mod = await import(pathToFileURL(PAGE).href);
    mini.render = () => mod.default({ address: CIRCLE });

    // seat 1 connected: pays round 1; its wallet signs and sends, devnet has not confirmed yet
    g.__wallet = walletOf(wallets[0]!, SIG_A);
    rerender();
    await settle();
    assert.match(text(mini.tree), /Seat 1: your 50 test USDC for round 1 is due\./, "precondition: seat 1 owes round 1");
    (payButton()!.props.onClick as () => void)();
    await settle();
    assert.match(text(mini.tree), /Payment: sent\. Confirming on devnet/, "precondition: seat 1's payment is in flight");

    // the visitor switches the wallet to seat 2, who also owes round 1, and pays
    g.__wallet = walletOf(wallets[1]!, SIG_B);
    rerender();
    await settle();
    assert.match(text(mini.tree), /Seat 2: your 50 test USDC for round 1 is due\./, "precondition: seat 2 owes round 1");
    // a page that keeps one transaction at a time across wallets (no second send while seat 1's is in flight) has
    // nothing to lose here
    if (payButton()!.props.disabled) return;
    (payButton()!.props.onClick as () => void)();
    await settle();
    assert.match(text(mini.tree), /Payment: sent\. Confirming on devnet/, "precondition: seat 2's payment is in flight");

    // seat 1's confirmation lands; seat 2's has not
    confirms.get(SIG_A)!({ value: { err: null } });
    await settle();
    rerender();
    await settle();

    const t = text(mini.tree);
    assert.ok(
      /Payment: sent\. Confirming on devnet/.test(t) || t.includes(SIG_B),
      "seat 2's payment was sent and is still confirming on devnet, but the page shows it nowhere to seat 2 (no status, no transaction)",
    );
  });
});
