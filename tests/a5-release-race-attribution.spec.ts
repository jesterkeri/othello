/**
 * Codex r2 on PR #22 (MEDIUM): releasePot takes no round, so after another member releases first (and the next round
 * is paid while this transaction is pending) this transaction releases the NEXT round. The page then looked up the
 * receipt a second time and, if that lookup failed, named the round and seat its button had shown: a confirmation that
 * this transaction paid Seat 1 when it paid Seat 2. Rule pinned here: the round and seat in the confirmation come only
 * from this transaction's own receipt as the adapter read it (ReleaseResult.released); with no such event the page
 * names no seat.
 *
 * Part 1, the real page (the hook runner of tests/a5-release-failure-linger-adversary.spec.ts) with the page's own
 * receipt lookup failing. Part 2, the real adapter and contracts on anvil: the race itself, B's transaction held at
 * the wallet until A has released round 1 and every seat has paid round 2.
 *
 *   cd evm && forge build --force && cd .. && npx mocha --import=tsx --timeout 300000 tests/a5-release-race-attribution.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient, createWalletClient, defineChain, http, keccak256,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { othelloCircleAbi, othelloFactoryAbi } from "../app/src/lib/robinhood/abi.generated.ts";
import { createRobinhoodAdapterWith } from "../app/src/lib/robinhood/adapter-core.ts";

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
    export const robinhoodPublicClient = { getTransactionReceipt: async () => { throw new Error("the page own receipt lookup failed"); } };
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
// after the race: A released round 1 to seat 1, every seat paid round 2, and this page's transaction released round 2
// to seat 2; round 3 (index 2) is open and unpaid
const afterRace = { ...base, round: 2, heldContributions: 0n, balance: 24n * U, block: 2,
  seats: [seat(0, { paid: false, received: true }), seat(1, { paid: false, received: true }), seat(2, { paid: false })] } as RhCircleView;

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

const text = (el: unknown): string =>
  el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el)
    : Array.isArray(el) ? el.map(text).join("") : text((el as El).props?.children);
type Phase = { kind: string; round?: number; recipientTurn?: number };

async function pressRelease() {
  const mod = await import(pathToFileURL(PAGE).href);
  mini.render = () => mod.default({ address: CIRCLE });
  io.view = round1;
  rerender();
  await settle();
  const before = payoutPanel()!;
  assert.equal((before.props.button as { recipientTurn: number }).recipientTurn, 0, "precondition: the button shows Seat 1's round");
  (before.props.onRelease as () => void)();
  await settle();
  io.onSent!(HASH);
  await settle();
}

describe("Codex r2 on PR #22, the page: a release that lost the race to round 1 names the round it really paid", () => {
  beforeEach(reset);

  it("the adapter's receipt says round 2, Seat 2: the page confirms Seat 2, though its own receipt lookup fails", async () => {
    await pressRelease();
    io.settleRelease!({ ok: true, txHash: HASH, released: { round: 1, recipient: W(1), pot: 6n * U } });
    await settle();
    const phase = payoutPanel()!.props.phase as Phase;
    assert.deepEqual({ kind: phase.kind, round: phase.round, recipientTurn: phase.recipientTurn },
      { kind: "released", round: 1, recipientTurn: 1 },
      "the confirmation must name the round and seat this transaction's own receipt paid, not the button's");
    // the forced refresh shows the chain after the race; "Confirmed" names Seat 2
    io.view = afterRace;
    io.intervals.find((x) => x.ms === 8_000)!.fn();
    await settle();
    const confirmed = (payoutPanel()!.props.steps as { key: string; status: string; detail: string }[]).find((s) => s.key === "confirmed")!;
    assert.equal(confirmed.status, "done");
    assert.match(confirmed.detail, /^Seat 2 received/);
  });

  it("no PotReleased in the receipt: the page names no seat, it says the release went through", async () => {
    await pressRelease();
    io.settleRelease!({ ok: true, txHash: HASH });
    await settle();
    assert.equal((payoutPanel()!.props.phase as Phase).kind, "idle", "no seat is named without the receipt's event");
    assert.match(text(mini.tree), /Release the pot: done/);
  });
});

// ---------------------------------------------------------------- part 2: the race on real contracts
const PORT = 8641;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet (local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } },
});
// anvil's public development mnemonic; these accounts exist only on the local chain
const MNEMONIC = "test test test test test test test test test test test junk";
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(new URL(`../evm/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
function ok(r: { ok: boolean; error?: string; message?: string }, what: string) {
  assert.equal(r.ok, true, r.ok ? what : `${what}: ${r.error}: ${r.message}`);
}

describe("Codex r2 on PR #22, the adapter: releasePot reports the round its own receipt released (anvil, chain 46630)", function () {
  this.timeout(120_000);
  let anvil: ChildProcess;
  let pub: PublicClient;
  const accounts = [0, 1, 2].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const wallets: WalletClient[] = [];

  async function deploy(w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  async function write(w: WalletClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account: w.account! } as never);
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...(request as object), chain } as never) });
    return result as unknown;
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 250 });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await sleep(100); }
    }
    for (const a of accounts) wallets.push(createWalletClient({ account: a, chain, transport: http(RPC) }));
  });
  after(() => anvil?.kill());

  it("B's release is held at the wallet while A releases round 1 and round 2 is paid: B's result says round 2, Seat 2", async () => {
    const mock = artifact("MockUSDG.sol", "MockUSDG");
    const usdg = await deploy(wallets[0]!, mock);
    for (const a of accounts) await write(wallets[0]!, usdg, mock.abi, "mint", [a.address, 1_000n * U]);
    const factory = await deploy(wallets[0]!, artifact("OthelloFactory.sol", "OthelloFactory"), [usdg]);
    const factoryHash = keccak256((await pub.getCode({ address: factory }))!);
    const circle = (await write(wallets[0]!, factory, othelloFactoryAbi as Abi, "createCircle", [
      { n: 3n, c: 10n * U, g: 5n * U, minStockCover: 12n * U, haircutBps: 2000n, coverageBps: 13000n, warnBps: 11000n,
        roundSecs: 3600n, graceSecs: 600n },
      accounts.map((a) => a.address),
    ])) as Address;
    const trusted = { address: factory, codeHash: factoryHash };
    const ads = accounts.map((a, i) => createRobinhoodAdapterWith({ publicClient: pub, walletClient: wallets[i]!, account: a.address, circle, factory: trusted, usdg }));
    for (const ad of ads) ok(await ad.joinAndLock({ amount: 20n * U }), "joinAndLock");
    ok(await ads[0]!.activate({}), "activate");
    for (const ad of ads) ok(await ad.contribute({}), "pay round 1");

    // B (seat 3) presses Release for round 1. Its wallet holds the transaction until A (seat 1) has released round 1
    // and every seat has paid round 2, then sends it: the contract releases whichever round is current.
    const realWrite = wallets[2]!.writeContract.bind(wallets[2]!);
    const raced = Object.assign(Object.create(Object.getPrototypeOf(wallets[2]!)), wallets[2]!, {
      writeContract: async (req: Parameters<WalletClient["writeContract"]>[0]) => {
        ok(await ads[0]!.releasePot({}), "A releases round 1");
        for (const ad of ads) ok(await ad.contribute({}), "pay round 2");
        return realWrite(req);
      },
    }) as WalletClient;
    const b = createRobinhoodAdapterWith({ publicClient: pub, walletClient: raced, account: accounts[2]!.address, circle, factory: trusted, usdg });
    const out = await b.releasePot({});
    ok(out, "B's release");
    assert.ok(out.ok && out.released, "the result carries the receipt's PotReleased");
    assert.deepEqual(out.ok && { round: out.released!.round, recipient: out.released!.recipient },
      { round: 1, recipient: accounts[1]!.address },
      "B's transaction released round 2 (index 1) to seat 2; it must not be reported as round 1");
    assert.equal(out.ok && out.released!.pot, 30n * U, "the pot is n x c");
    const round = Number(await pub.readContract({ address: circle, abi: othelloCircleAbi as Abi, functionName: "round" }));
    assert.equal(round, 2, "precondition: the chain moved on to round 3");
  });
});
