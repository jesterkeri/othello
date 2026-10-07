/**
 * A7 adversary, sixth pass: the shared single-circle page on a Solana circle (PR #27, 2781941), against its spec.
 *
 *   Spec 2: "No step, tick, status line, banner or panel claims something the chain has not done or does not hold;
 *   every action's outcome (done, declined, refused, unconfirmed) shows to the wallet that sent it, in the round and
 *   circle state it applies to, with its transaction where one was sent, and nowhere after".
 *
 * 2781941 scopes a finished outcome in the status line to the round AND the circle state it was sent from
 * (LiveCircle.tsx `stale`). The release's outcome lives in the payout panel instead, which drops a failure only by
 * round (`shownRelease`), and the panel is drawn whenever `shownRelease` is not idle, Active or not. The last round's
 * release_pot completes the circle WITHOUT advancing the round and zeroes paid_bitmap
 * (programs/othello/src/instructions/release_pot.rs:334-346). So a last-round release that failed (here: sent, then
 * not confirmed in time, though it landed) keeps the payout panel on the Completed circle, and its "Payments" step is
 * computed from the zeroed paid bitmap: "0 of 5 paid; waiting for Seat 1 ... Seat 5", blocked. The chain holds a
 * completed circle whose every pot is paid out.
 *
 * Sequence: round 5 of 5, every seat paid, price fresh. A wallet that is not a member presses "Release pot to
 * <seat 5>"; the wallet sends it; confirmTransaction gives up (block height exceeded, as web3.js does when devnet is
 * slow); the page re-reads, and the read shows the release landed: Completed, round index 4, every seat received.
 * The same steps follow when the release was declined in the wallet and another member's release completed the
 * circle.
 *
 * Harness: the minimal hook runner of tests/a7-circle-page-wallet-switch-adversary.spec.ts, so `send` really runs;
 * the wallet, the connection and fetch are driven by the test. No network: getLatestBlockhash, sendTransaction and
 * confirmTransaction are local stubs; releasePotIx is the repo's own instruction builder (no I/O).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-completed-release-adversary.spec.ts     (installs hooks: its own process)
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
type Step = { key: string; label: string; status: string; detail: string };
const payoutPanel = () => find(mini.tree, (e) => typeof e.props.onRelease === "function");

// ---------------------------------------------------------------- chain state: round 5 of 5, every seat has paid
const mints = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const NOW = Math.floor(Date.now() / 1000);
const A = CIRCLE_STATES.active;
const wallets = A.members.map(() => anchor.web3.Keypair.generate().publicKey);
const CIRCLE = anchor.web3.Keypair.generate().publicKey.toBase58();
const lastRound: CircleView = {
  ...A,
  members: A.members.map((m, i) => ({ ...m, address: wallets[i]!.toBase58() })),
  status: "Active",
  round: 4,
  paidBitmap: 0b11111,
  receivedBitmap: 0b01111,
  defaultedBitmap: 0,
  withdrawnBitmap: 0,
  nextGateShortBy: 0,
  roundDeadline: NOW + 600,
  feed: { ...A.feed, updatedAt: NOW - 30 },
};
// the read once the release has landed (release_pot.rs:332-346): Completed, round not advanced, paid_bitmap zeroed
const completed: CircleView = { ...lastRound, status: "Completed", paidBitmap: 0, receivedBitmap: 0b11111, roundDeadline: NOW };
const liveOf = (view: CircleView) => ({
  view,
  accounts: { circle: CIRCLE, usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
  split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
  pool: { discountBps: 2000, usdc: 1_000_000_000 },
  readAt: NOW,
});
let chain = liveOf(lastRound);
g.fetch = async () => ({ json: async () => chain });

const SIG = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
let confirm: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
g.__conn = {
  getLatestBlockhash: async () => ({ blockhash: anchor.web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
  confirmTransaction: () => new Promise((res, rej) => (confirm = { resolve: res, reject: rej })),
  getTransaction: async () => null,
};

describe("A7 adversary: the last round's failed release on a completed circle", () => {
  it("the payout panel does not say the completed circle's seats have yet to pay", async () => {
    const mod = await import(pathToFileURL(PAGE).href);
    mini.render = () => mod.default({ address: CIRCLE });

    // a wallet that is not a member: anyone may release a settled pot (SPEC 5)
    g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => SIG };
    rerender();
    await settle();
    const before = payoutPanel();
    assert.ok(before, "precondition: the payout panel is drawn in the last round");
    const btn = before!.props.button as { label: string; enabled: boolean };
    assert.ok(btn.enabled, `precondition: "${btn.label}" is enabled`);

    // the release is sent; devnet is slow and web3.js gives up confirming it
    (before!.props.onRelease as () => void)();
    await settle();
    assert.ok(confirm, "precondition: the release was sent and is being confirmed");
    chain = liveOf(completed); // it landed
    confirm!.reject(new anchor.web3.TransactionExpiredBlockheightExceededError(SIG));
    await settle();
    rerender();
    await settle();

    // precondition: the page now reads the completed circle
    assert.match(text(mini.tree), /All 5 rounds are paid out/, "precondition: the read shows the circle Completed");

    const panel = payoutPanel();
    const steps = (panel?.props.steps as Step[] | undefined) ?? [];
    const payments = steps.find((s) => s.key === "payments");
    assert.ok(
      !payments || !/waiting for/.test(payments.detail),
      `the completed circle's payout panel says "${payments?.label}: ${payments?.detail}" (${payments?.status}), though every pot is paid out`,
    );
  });
});
