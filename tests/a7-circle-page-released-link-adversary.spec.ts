/**
 * A7 adversary, seventh pass: the shared single-circle page on a Solana circle (PR #27, 115079f), against its spec.
 *
 *   Spec 2: "every action's outcome (done, declined, refused, unconfirmed) shows to the wallet that sent it, in the
 *   round and circle state it applies to, with its transaction where one was sent, and nowhere after".
 *
 * A release's outcome lives only in the shared payout panel (LiveCircle.tsx: `isRelease` blanks the status line and
 * its link). The panel links the transaction while it is "sent" and when it "failed", and once "released" only inside
 * the confirmed view (PayoutPanel.tsx: `confirmed && phase.kind === "released"`). Between the successful receipt and
 * the first read that shows the recipient as received, the panel ticks "Pot released" ("... left the pot in a
 * successful transaction") with no link to that transaction anywhere on the page. The page re-reads at once, but
 * /api/circle serves a read up to CACHE_SECONDS (4 s) old (app/src/app/api/circle/route.ts), so that first re-read is
 * usually still the pre-release circle; with devnet rate-limited (the route's 502) it stays so indefinitely. Before
 * this PR the Solana page said "Release: done. View the transaction" the moment the receipt came back.
 *
 * Sequence: round 2 of 5, every seat paid, price fresh. A wallet that is not a member presses "Release pot to
 * <seat 2>"; the wallet sends it; confirmTransaction returns success; the page re-reads and gets the cached read from
 * before the release (still round 2, seat 2 not yet received).
 *
 * Harness: the minimal hook runner of tests/a7-circle-page-completed-release-adversary.spec.ts, so `send` really runs;
 * the wallet, the connection and fetch are driven by the test. No network: getLatestBlockhash, sendTransaction and
 * confirmTransaction are local stubs; releasePotIx is the repo's own instruction builder (no I/O).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a7-circle-page-released-link-adversary.spec.ts     (installs hooks: its own process)
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

// ---------------------------------------------------------------- chain state: round 2 of 5, every seat has paid
const mints = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const NOW = Math.floor(Date.now() / 1000);
const A = CIRCLE_STATES.active;
const wallets = A.members.map(() => anchor.web3.Keypair.generate().publicKey);
const CIRCLE = anchor.web3.Keypair.generate().publicKey.toBase58();
const round2: CircleView = {
  ...A,
  members: A.members.map((m, i) => ({ ...m, address: wallets[i]!.toBase58() })),
  status: "Active",
  round: 1,
  paidBitmap: 0b11111,
  receivedBitmap: 0b00001,
  defaultedBitmap: 0,
  withdrawnBitmap: 0,
  nextGateShortBy: 0,
  roundDeadline: NOW + 600,
  feed: { ...A.feed, updatedAt: NOW - 30 },
};
const liveOf = (view: CircleView) => ({
  view,
  accounts: { circle: CIRCLE, usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
  split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
  pool: { discountBps: 2000, usdc: 1_000_000_000 },
  readAt: NOW,
});
// /api/circle's cached read (route.ts CACHE_SECONDS): still the circle from before the release
const chain = liveOf(round2);
g.fetch = async () => ({ json: async () => chain });

const SIG = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
let confirm: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
g.__conn = {
  getLatestBlockhash: async () => ({ blockhash: anchor.web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
  confirmTransaction: () => new Promise((res, rej) => (confirm = { resolve: res, reject: rej })),
  getTransaction: async () => null,
};

// the page's own elements, plus what the payout panel draws (PayoutPanel is a plain function of its props, no hooks)
const hasLink = (el: unknown, hash: string) => Boolean(find(el, (e) => typeof e.props.href === "string" && (e.props.href as string).includes(hash)));
const linksTo = (tree: unknown, hash: string) => {
  const panel = payoutPanel();
  const drawn = panel ? (panel.type as (p: Record<string, unknown>) => unknown)(panel.props) : null;
  return hasLink(tree, hash) || hasLink(drawn, hash);
};

describe("A7 adversary: a successful release before the read shows it", () => {
  it("the page links the release's transaction once the release is done", async () => {
    const mod = await import(pathToFileURL(PAGE).href);
    mini.render = () => mod.default({ address: CIRCLE });

    // a wallet that is not a member: anyone may release a settled pot (SPEC 5)
    g.__wallet = { publicKey: anchor.web3.Keypair.generate().publicKey, sendTransaction: async () => SIG };
    rerender();
    await settle();
    const before = payoutPanel();
    assert.ok(before, "precondition: the payout panel is drawn");
    const btn = before!.props.button as { label: string; enabled: boolean };
    assert.ok(btn.enabled, `precondition: "${btn.label}" is enabled`);

    (before!.props.onRelease as () => void)();
    await settle();
    assert.ok(confirm, "precondition: the release was sent and is being confirmed");
    assert.ok(linksTo(mini.tree, SIG), "precondition: while sent, the page links the transaction");

    // the receipt: success
    confirm!.resolve({ context: { slot: 1 }, value: { err: null } });
    await settle();
    rerender();
    await settle();

    const panel = payoutPanel();
    const steps = (panel?.props.steps as Step[] | undefined) ?? [];
    const released = steps.find((s) => s.key === "released");
    assert.equal(released?.status, "done", `precondition: the panel says the pot was released ("${released?.detail}")`);

    assert.ok(
      linksTo(mini.tree, SIG),
      `the page says "${released?.label}: ${released?.detail}" (${released?.status}) for the release this wallet sent, but links its transaction nowhere`,
    );
  });
});
