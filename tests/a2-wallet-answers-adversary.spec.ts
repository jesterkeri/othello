/**
 * Adversary, A2-SWITCH (othello-design/arb/A2-SWITCH.md), second pass on b94f89a. Extends the seeded search of
 * tests/a2-modal-search-adversary.spec.ts (same invariants I1 to I5 and L, same hook runtime over the real
 * app/src/lib/wallet.tsx and the real createEvmSession) where that model was silent:
 *
 *   - A Solana wallet that is no longer selected answers the prompt it opened. The earlier model ignored such a
 *     refusal ("conservative"). @solana/wallet-adapter-react 0.15.40 does not:
 *       WalletProvider.js     handleConnectError = () => { if (adapter) changeWallet(null) }, and changeWallet closes over
 *                             the `walletName` and `adapter` of the render that created it; setWalletName is a plain
 *                             useState setter (useLocalStorage.js).
 *       WalletProviderBase.js the autoConnect effect captures `onAutoConnectRequest` and `onConnectError` when it runs,
 *                             and on a rejection calls that captured `onConnectError()`; its `finally` clears the shared
 *                             isConnectingRef. The adapter's own 'error' event reaches onError only through the
 *                             listener of the adapter selected now (the effect keyed on `adapter` removes the old one).
 *       wallet-standard-wallet-adapter-base 1.1.6 adapter.js #connect: `if (this.connected || this.connecting) return;`
 *                             with no event, and a late approval still runs #connected (sets publicKey), emitting
 *                             'connect' to no one.
 *     So a late refusal from the deselected wallet deselects whichever Solana wallet is selected now, without onError;
 *     a late approval leaves that adapter connected inside, so selecting it again later asks nothing and emits nothing.
 *   - EVM wallets: MetaMask answers a second eth_requestAccounts while its prompt is open with -32002; a wallet already
 *     authorised answers eth_requestAccounts without a prompt; the network switch is a prompt of its own (Rabby); reads
 *     (eth_accounts, eth_chainId) are answered late with the state at the time they were asked; account switch, lock
 *     (accountsChanged []), chain change and the extension going away (every request rejects) at any stage.
 *   - The modal offers what WalletConnect.tsx renders: only the connected Solana wallet while one is connected; the top
 *     bar's Disconnect and "Switch network" on each side.
 *   - Starting states: nothing, Solana connected, EVM connected (restored by rdns), both; on / and on /robinhood.
 *
 * Added checks: R (the remembered EVM wallet changes only on a live connect or on Disconnect), E1 (once the chosen EVM
 * wallet has answered every read, the session shows its current account and network), and I5 on load (a restore asks
 * for nothing).
 *
 *   npx mocha --import=tsx tests/a2-wallet-answers-adversary.spec.ts
 *   A2_DEPTH=8 A2_BUDGET=5000 npx mocha --import=tsx tests/a2-wallet-answers-adversary.spec.ts   (the full session)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import type { Discovery, EvmWallet } from "../app/src/lib/robinhood/eip6963.ts";
import { createEvmSession, ROBINHOOD_HEX_ID, type EvmSession } from "../app/src/lib/robinhood/evm-session.ts";

const SRC = resolve(REPO, "app/src");
const WALLET_TSX = resolve(SRC, "lib/wallet.tsx");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Hooks = {
  useState(i: unknown): [unknown, (v: unknown) => void];
  useRef(i: unknown): { current: unknown };
  useMemo(f: () => unknown, deps: unknown[]): unknown;
  useCallback(f: unknown, deps: unknown[]): unknown;
  useEffect(f: () => void | (() => void), deps?: unknown[]): void;
  evm(): unknown;
  solana(): unknown;
  router(): unknown;
  pathname(): string;
  onError?: (e: unknown) => void;
};
const g = globalThis as { __a2?: Hooks; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const fromWallet = context.parentURL?.endsWith("/lib/wallet.tsx") ?? false;
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (fromWallet && specifier === "react") {
      return stub(
        "const H = () => globalThis.__a2;" +
        "export const useState = (i) => H().useState(i);" +
        "export const useRef = (i) => H().useRef(i);" +
        "export const useMemo = (f, d) => H().useMemo(f, d);" +
        "export const useCallback = (f, d) => H().useCallback(f, d);" +
        "export const useEffect = (f, d) => H().useEffect(f, d);" +
        "export const createContext = (d) => ({ Provider: 'Provider', d });" +
        "export const useContext = (c) => c.d;",
      );
    }
    if (fromWallet && specifier === "next/navigation") {
      return stub("export const useRouter = () => globalThis.__a2.router(); export const usePathname = () => globalThis.__a2.pathname();");
    }
    if (fromWallet && specifier === "@solana/wallet-adapter-react") {
      return stub(
        "export const useWallet = () => globalThis.__a2.solana(); export const ConnectionProvider = (p) => p.children;" +
        "export const WalletProvider = (p) => { globalThis.__a2.onError = p.onError; return p.children; };",
      );
    }
    if (fromWallet && specifier === "@solana/wallet-adapter-base") return stub("export const WalletReadyState = { Installed: 'Installed' };");
    if (fromWallet && specifier === "@solana/web3.js") return stub("export const clusterApiUrl = () => 'https://api.devnet.solana.com';");
    if (fromWallet && specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => globalThis.__a2.evm();");
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

const ETHEREUM = "0x1";
const OTHER_CHAIN = "0x89";

/**
 * A fake EIP-1193 wallet. `eth_requestAccounts` answers at once when the site is already authorised and the wallet is
 * unlocked (MetaMask, Rabby), otherwise opens a prompt; `busy` wallets (MetaMask) answer a second one while the prompt
 * is open with -32002. `switchPrompt` wallets open a prompt for the network switch; the others accept or refuse at
 * once. `lateReads` wallets answer eth_accounts and eth_chainId later, with the state at the time of asking. A wallet
 * that `dies` (extension disabled) rejects everything pending and everything after.
 */
class Wallet {
  calls: string[] = [];
  granted = 0;
  authorised = false;
  locked = false;
  dead = false;
  chain = ETHEREUM;
  private n = 1;
  private handlers = new Map<string, Set<(x: unknown) => void>>();
  private waiting: { ok: (a: string[]) => void; no: (e: unknown) => void }[] = [];
  private switching: { ok: (v: null) => void; no: (e: unknown) => void; to: string }[] = [];
  private reads: { ok: (v: unknown) => void; no: (e: unknown) => void; v: unknown }[] = [];
  constructor(private digit: string, private o: { refusesSwitch: boolean; busy: boolean; switchPrompt: boolean; lateReads: boolean }) {}
  get account() { return `0x${this.digit.repeat(39)}${this.n % 10}`; }
  private accounts() { return this.authorised && !this.locked ? [this.account] : []; }
  private gone() { return Object.assign(new Error("Disconnected from the extension. Page reload required."), { code: -32603 }); }
  request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    this.calls.push(method);
    if (this.dead) throw this.gone();
    if (method === "eth_requestAccounts") {
      if (this.authorised && !this.locked) { this.granted++; return [this.account]; }
      if (this.o.busy && this.waiting.length) {
        throw Object.assign(new Error("Request of type 'wallet_requestPermissions' already pending for origin http://localhost:3000. Please wait."), { code: -32002 });
      }
      return new Promise<string[]>((ok, no) => { this.waiting.push({ ok, no }); });
    }
    if (method === "eth_accounts" || method === "eth_chainId") {
      const v = method === "eth_accounts" ? this.accounts() : this.chain;
      if (!this.o.lateReads) return v;
      return new Promise((ok, no) => { this.reads.push({ ok, no, v }); });
    }
    if (method === "wallet_switchEthereumChain") {
      const to = (params as [{ chainId: string }])[0].chainId;
      if (this.o.switchPrompt) return new Promise((ok, no) => { this.switching.push({ ok, no, to }); });
      if (this.o.refusesSwitch) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      this.setChain(to);
      return null;
    }
    if (method === "wallet_revokePermissions") { this.authorised = false; return null; }
    throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
  };
  get prompting() { return this.waiting.length > 0; }
  get switchOpen() { return this.switching.length > 0; }
  get readsOpen() { return this.reads.length > 0; }
  approve() {
    const w = this.waiting; this.waiting = [];
    const had = this.accounts().length > 0;
    this.authorised = true; this.locked = false;
    // A site that becomes able to see the account (first grant, or unlock) is told so by accountsChanged (MetaMask).
    if (!had) this.emit("accountsChanged", [this.account]);
    for (const x of w) { this.granted++; x.ok([this.account]); }
  }
  refuse() { const w = this.waiting; this.waiting = []; for (const x of w) x.no(Object.assign(new Error("User rejected the request."), { code: 4001 })); }
  approveSwitch() { const s = this.switching; this.switching = []; for (const x of s) { this.setChain(x.to); x.ok(null); } }
  refuseSwitch() { const s = this.switching; this.switching = []; for (const x of s) x.no(Object.assign(new Error("User rejected the request."), { code: 4001 })); }
  answerReads() { const r = this.reads; this.reads = []; for (const x of r) x.ok(x.v); }
  switchAccount() { if (!this.accounts().length) return; this.n++; this.emit("accountsChanged", [this.account]); }
  lock() { if (!this.accounts().length) return; this.locked = true; this.emit("accountsChanged", []); }
  changeChain() { this.setChain(this.chain === ETHEREUM ? OTHER_CHAIN : ETHEREUM); }
  die() {
    this.dead = true;
    const all = [...this.waiting, ...this.switching, ...this.reads];
    this.waiting = []; this.switching = []; this.reads = [];
    for (const x of all) x.no(this.gone());
    this.emit("disconnect", this.gone());
  }
  private setChain(c: string) { if (c === this.chain) return; this.chain = c; this.emit("chainChanged", c); }
  on(ev: string, f: (x: unknown) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(f); }
  removeListener(ev: string, f: (x: unknown) => void) { this.handlers.get(ev)?.delete(f); }
  emit(ev: string, x: unknown) { for (const f of this.handlers.get(ev) ?? []) f(x); }
}

const settle = async () => { for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r)); };

type Ui = {
  stage: string;
  pending: string | null;
  pendingKind: string | null;
  solanaBusy: boolean;
  address: string | null;
  pick(name: string): void;
  pickEvm(uuid: string): void;
  cancel(): void;
  close(): void;
  openConnect(): void;
  retry(): void;
  another(): void;
  disconnect(): void;
};

type SolName = "Phantom" | "Solflare";
type Opts = { path: string; sol?: boolean; evm?: "uuid-a" | "uuid-b" };

async function mount(opts: Opts) {
  const React = appRequire("react");
  g.React = React;
  const { WalletProviders } = await import(pathToFileURL(WALLET_TSX).href);

  const wa = new Wallet("1", { refusesSwitch: false, busy: false, switchPrompt: true, lateReads: true });
  const wb = new Wallet("2", { refusesSwitch: true, busy: true, switchPrompt: false, lateReads: false });
  const byUuid: Record<string, Wallet> = { "uuid-a": wa, "uuid-b": wb };
  const evmWallets: EvmWallet[] = [
    { info: { uuid: "uuid-a", name: "Rabby", rdns: "io.rabby", icon: null }, provider: wa as never },
    { info: { uuid: "uuid-b", name: "MetaMask", rdns: "io.metamask", icon: null }, provider: wb as never },
  ];
  const remembered = { value: null as string | null, get: () => remembered.value, set: (v: string) => { remembered.value = v; }, clear: () => { remembered.value = null; } };
  if (opts.evm) {
    // Connected in an earlier visit: authorised, on Robinhood Chain, remembered by rdns.
    const w = byUuid[opts.evm]!;
    w.authorised = true;
    w.chain = ROBINHOOD_HEX_ID;
    remembered.value = evmWallets.find((x) => x.info.uuid === opts.evm)!.info.rdns;
  }
  const discovery: Discovery = { list: () => evmWallets, subscribe: () => () => {}, stop: () => {} };
  const session: EvmSession = createEvmSession({ discovery, remembered });

  // The Solana provider, as WalletProvider + WalletProviderBase + StandardWalletAdapter behave (see the header).
  const adapters: Record<SolName, { connected: boolean; prompt: boolean; account: number }> = {
    Phantom: { connected: false, prompt: false, account: 1 },
    Solflare: { connected: false, prompt: false, account: 1 },
  };
  const sol = { selected: null as SolName | null, connected: false, publicKey: null as string | null, isConnecting: false };
  const prompted: string[] = [];
  if (opts.sol) {
    adapters.Phantom.connected = true;
    Object.assign(sol, { selected: "Phantom", connected: true, publicKey: "Phantom#1" });
  }
  const walletsList = (["Phantom", "Solflare"] as const).map((name) => ({ readyState: "Installed", adapter: { name, icon: "data:image/png;base64,AA==" } }));
  /** adapter.connect() started by the provider (autoConnect or handleConnect). */
  const openPrompt = (name: SolName) => {
    const a = adapters[name];
    // StandardWalletAdapter #connect: `if (this.connected || this.connecting) return;` resolves at once, no event, and
    // the provider's `finally` clears isConnectingRef.
    if (a.connected || a.prompt) { sol.isConnecting = false; return; }
    a.prompt = true;
    prompted.push(name);
    sol.isConnecting = true;
  };
  let w: unknown;
  const buildW = () => {
    w = {
      connected: sol.connected,
      connecting: sol.isConnecting,
      publicKey: sol.publicKey ? { toBase58: () => sol.publicKey } : null,
      wallet: sol.selected ? { adapter: { name: sol.selected } } : null,
      wallets: walletsList,
      select: (name: SolName) => {
        if (sol.selected === name) return;
        if (sol.selected) adapters[sol.selected].connected = false; // changeWallet: adapter.disconnect()
        sol.selected = name;
        Object.assign(sol, { connected: false, publicKey: null, isConnecting: false }); // listener cleanup: handleDisconnect()
        openPrompt(name); // autoConnect, hasUserSelectedAWallet: adapter.connect()
        changed();
      },
      connect: async () => {
        if (sol.isConnecting || !sol.selected || adapters[sol.selected].connected) return;
        openPrompt(sol.selected);
        changed();
      },
      disconnect: async () => {
        if (!sol.selected) return;
        adapters[sol.selected].connected = false;
        Object.assign(sol, { selected: null, connected: false, publicKey: null, isConnecting: false });
        changed();
      },
    };
  };
  buildW();

  const pushes: string[] = [];
  let path = opts.path;
  const router = { push: (to: string) => { pushes.push(to); path = to; } };

  const slots: unknown[] = [];
  let i = 0;
  let rendering = false;
  let dirty = false;
  let queued: (() => void)[] = [];
  let ui!: Ui;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));

  const hooks: Hooks = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = init;
      const set = (v: unknown) => {
        const next = typeof v === "function" ? (v as (p: unknown) => unknown)(slots[k]) : v;
        if (Object.is(next, slots[k])) return;
        slots[k] = next;
        rerender();
      };
      return [slots[k], set];
    },
    useRef(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { current: init };
      return slots[k] as { current: unknown };
    },
    useMemo(f, deps) {
      const k = i++;
      const prev = slots[k] as { deps: unknown[]; v: unknown } | undefined;
      if (prev && same(prev.deps, deps)) return prev.v;
      const v = f();
      slots[k] = { deps, v };
      return v;
    },
    useCallback(f, deps) { return hooks.useMemo(() => f, deps); },
    useEffect(f, deps) {
      const k = i++;
      const prev = slots[k] as { deps?: unknown[]; cleanup?: void | (() => void) } | undefined;
      if (prev && same(prev.deps, deps)) return;
      queued.push(() => {
        if (typeof prev?.cleanup === "function") prev.cleanup();
        slots[k] = { deps, cleanup: f() };
      });
    },
    evm() {
      const snap = session.getSnapshot();
      return { wallets: snap.wallets, connectWith: (u: string) => session.connectWith(u), disconnect: () => session.disconnect(), cancelPending: () => session.cancelPending() };
    },
    solana: () => w,
    router: () => router,
    pathname: () => path,
  };

  function renderOnce() {
    g.__a2 = hooks;
    i = 0;
    queued = [];
    const el = (WalletProviders as (p: { children: null }) => unknown)({ children: null });
    let node = el as { type: unknown; props: { children?: unknown; value?: Ui } };
    while (node.type !== "Provider") {
      const t = node.type as (p: unknown) => unknown;
      node = t(node.props) as typeof node;
    }
    ui = node.props.value!;
    const effects = queued;
    for (const e of effects) e();
  }
  function rerender() {
    if (rendering) { dirty = true; return; }
    rendering = true;
    try {
      let n = 0;
      do {
        dirty = false;
        renderOnce();
        if (++n > 50) throw new Error("render loop");
      } while (dirty);
    } finally {
      rendering = false;
    }
  }
  /** The Solana provider's state changed: WalletProviderBase re-renders, so `useWallet()` is a new object. */
  function changed() { buildW(); rerender(); }
  session.subscribe(rerender);
  rerender();

  const solApprove = (name: SolName) => {
    const a = adapters[name];
    if (!a.prompt) return;
    a.prompt = false;
    a.connected = true; // #connected runs whether or not anyone listens
    if (sol.selected !== name) {
      // 'connect' reaches no listener; the old autoConnect's `finally` clears the shared isConnectingRef.
      if (sol.isConnecting) { sol.isConnecting = false; changed(); }
      return;
    }
    Object.assign(sol, { connected: true, publicKey: `${name}#${a.account}`, isConnecting: false });
    changed();
  };
  const solRefuse = (name: SolName) => {
    const a = adapters[name];
    if (!a.prompt) return;
    a.prompt = false;
    if (sol.selected === name) {
      sol.isConnecting = false;
      const inner = Object.assign(new Error("User rejected the request."), { code: 4001 });
      g.__a2!.onError?.(Object.assign(new Error("User rejected the request."), { name: "WalletConnectionError", error: inner }));
      Object.assign(sol, { selected: null, connected: false, publicKey: null }); // handleConnectError: changeWallet(null)
      changed();
      return;
    }
    // Deselected. The adapter's 'error' event has no provider listener any more (no onError). The connect's rejection
    // still reaches the onConnectError captured when that connect began: WalletProvider handleConnectError of the render
    // where `name` was selected, whose changeWallet(null) sees walletName === name (stale), calls name's
    // adapter.disconnect() and then setWalletName(null): the wallet selected NOW is deselected. Its adapter is not
    // disconnected (the stale closure disconnects `name`'s). WalletProviderBase's `finally` clears isConnectingRef.
    a.connected = false;
    if (sol.selected) Object.assign(sol, { selected: null, connected: false, publicKey: null });
    sol.isConnecting = false;
    changed();
  };
  /** The person switches account inside the selected Solana wallet: the adapter re-emits connect with the new key. */
  const solSwitchAccount = () => {
    const name = sol.selected;
    if (!name || !adapters[name].connected || !sol.connected) return;
    const a = adapters[name];
    a.account++;
    sol.publicKey = `${name}#${a.account}`;
    changed();
  };

  await settle();
  return {
    ui: () => ui,
    session,
    wa, wb, byUuid, remembered,
    pushes,
    path: () => path,
    goTo: (p: string) => { path = p; rerender(); },
    sol, adapters, prompted,
    solApprove, solRefuse, solSwitchAccount,
  };
}

type M = Awaited<ReturnType<typeof mount>>;

/* ------------------------------------------------------------------ the search ------------------------------------------------------------------ */

type Act =
  | "open" | "pickPhantom" | "pickSolflare" | "pickA" | "pickB" | "cancel" | "close" | "retry" | "another" | "switchSide"
  | "solDisconnect" | "evmDisconnect" | "switchNetwork"
  | "phantomApproves" | "phantomRefuses" | "solflareApproves" | "solflareRefuses" | "solSwitchesAccount"
  | "aApproves" | "aRefuses" | "bApproves" | "bRefuses" | "aSwitchApproves" | "aSwitchRefuses" | "aReads"
  | "aAccount" | "bAccount" | "aLocks" | "bLocks" | "aChain" | "bChain" | "aDies" | "bDies";

const SOLANA_HOME = "/";
const RH_HOME = "/robinhood";
const onSide = (p: string) => (p === RH_HOME || p.startsWith(`${RH_HOME}/`) ? "robinhood" : "solana");
const RDNS: Record<string, string> = { "uuid-a": "io.rabby", "uuid-b": "io.metamask" };

/** What the person has asked for, kept by the test. */
type Model = { sol: { name: string; live: boolean } | null; evm: { uuid: string; live: boolean } | null; kind: "solana" | "robinhood" | null };

function enabled(m: M, externals: boolean): Act[] {
  const u = m.ui();
  const acts: Act[] = [];
  const e = m.session.getSnapshot();
  if (u.stage === "closed") {
    const side = onSide(m.path());
    if (side === "solana") acts.push(m.sol.connected ? "solDisconnect" : "open");
    else if (!e.address) acts.push("open");
    else if (e.chainId !== Number.parseInt(ROBINHOOD_HEX_ID, 16)) acts.push("switchNetwork");
    else acts.push("evmDisconnect");
    acts.push("switchSide");
  }
  if (u.stage === "list") {
    // WalletConnect.tsx: while a Solana wallet is connected only that one is offered.
    if (m.sol.connected) acts.push(m.sol.selected === "Phantom" ? "pickPhantom" : "pickSolflare");
    else acts.push("pickPhantom", "pickSolflare");
    acts.push("pickA", "pickB");
  }
  if (u.stage === "connecting") acts.push("cancel");
  if (u.stage !== "closed") acts.push("close");
  if (u.stage === "rejected" || u.stage === "failed") acts.push("retry", "another");
  if (m.adapters.Phantom.prompt) acts.push("phantomApproves", "phantomRefuses");
  if (m.adapters.Solflare.prompt) acts.push("solflareApproves", "solflareRefuses");
  if (m.wa.prompting) acts.push("aApproves", "aRefuses");
  if (m.wb.prompting) acts.push("bApproves", "bRefuses");
  if (m.wa.switchOpen) acts.push("aSwitchApproves", "aSwitchRefuses");
  if (m.wa.readsOpen) acts.push("aReads");
  if (externals) {
    if (m.sol.connected) acts.push("solSwitchesAccount");
    if (!m.wa.dead) { acts.push("aChain", "aDies"); if (m.wa.authorised && !m.wa.locked) acts.push("aAccount", "aLocks"); }
    if (!m.wb.dead) { acts.push("bChain", "bDies"); if (m.wb.authorised && !m.wb.locked) acts.push("bAccount", "bLocks"); }
  }
  return acts;
}

type Snap = {
  stage: string; sol: string | null; evm: string | null; pushes: number; remembered: string | null;
  aReq: number; bReq: number; prompted: number; aSwitch: number; bSwitch: number; aGranted: number; bGranted: number;
};
const count = (calls: string[], m: string) => calls.filter((c) => c === m).length;
function snap(m: M): Snap {
  return {
    stage: m.ui().stage,
    sol: m.sol.connected ? m.sol.selected : null,
    evm: m.session.getSnapshot().chosen?.info.uuid ?? null,
    pushes: m.pushes.length,
    remembered: m.remembered.value,
    aReq: count(m.wa.calls, "eth_requestAccounts"), bReq: count(m.wb.calls, "eth_requestAccounts"),
    aSwitch: count(m.wa.calls, "wallet_switchEthereumChain"), bSwitch: count(m.wb.calls, "wallet_switchEthereumChain"),
    aGranted: m.wa.granted, bGranted: m.wb.granted,
    prompted: m.prompted.length,
  };
}

const ANSWERS: Partial<Record<Act, string>> = {
  aApproves: "uuid-a", aRefuses: "uuid-a", aSwitchApproves: "uuid-a", aSwitchRefuses: "uuid-a", aDies: "uuid-a",
  bApproves: "uuid-b", bRefuses: "uuid-b", bDies: "uuid-b",
};

async function step(m: M, x: Model, a: Act): Promise<string | null> {
  const before = snap(m);
  const kindBefore = x.kind;
  const stageBefore = before.stage;
  const u = m.ui();
  const pathBefore = m.path();
  let picked: { kind: "solana" | "robinhood"; id: string } | null = null;
  switch (a) {
    case "open": u.openConnect(); break;
    case "pickPhantom": case "pickSolflare": picked = { kind: "solana", id: a === "pickPhantom" ? "Phantom" : "Solflare" }; u.pick(picked.id); break;
    case "pickA": case "pickB": picked = { kind: "robinhood", id: a === "pickA" ? "uuid-a" : "uuid-b" }; u.pickEvm(picked.id); break;
    case "cancel": u.cancel(); break;
    case "close": u.close(); break;
    case "retry":
      picked = x.kind === "robinhood" ? { kind: "robinhood", id: x.evm!.uuid } : { kind: "solana", id: x.sol!.name };
      u.retry();
      break;
    case "another": u.another(); break;
    case "switchSide": m.goTo(onSide(m.path()) === "solana" ? RH_HOME : SOLANA_HOME); break;
    case "solDisconnect": u.disconnect(); break;
    case "evmDisconnect": m.session.disconnect(); break;
    case "switchNetwork": void m.session.switchToRobinhood(); break;
    case "phantomApproves": m.solApprove("Phantom"); break;
    case "phantomRefuses": m.solRefuse("Phantom"); break;
    case "solflareApproves": m.solApprove("Solflare"); break;
    case "solflareRefuses": m.solRefuse("Solflare"); break;
    case "solSwitchesAccount": m.solSwitchAccount(); break;
    case "aApproves": m.wa.approve(); break;
    case "aRefuses": m.wa.refuse(); break;
    case "bApproves": m.wb.approve(); break;
    case "bRefuses": m.wb.refuse(); break;
    case "aSwitchApproves": m.wa.approveSwitch(); break;
    case "aSwitchRefuses": m.wa.refuseSwitch(); break;
    case "aReads": m.wa.answerReads(); break;
    case "aAccount": m.wa.switchAccount(); break;
    case "bAccount": m.wb.switchAccount(); break;
    case "aLocks": m.wa.lock(); break;
    case "bLocks": m.wb.lock(); break;
    case "aChain": m.wa.changeChain(); break;
    case "bChain": m.wb.changeChain(); break;
    case "aDies": m.wa.die(); break;
    case "bDies": m.wb.die(); break;
  }
  await settle();
  const after = snap(m);

  // Model: the person's intent.
  if (picked?.kind === "solana") { x.sol = { name: picked.id, live: true }; if (x.evm) x.evm.live = false; x.kind = "solana"; }
  if (picked?.kind === "robinhood") { x.evm = { uuid: picked.id, live: true }; if (x.sol) x.sol.live = false; x.kind = "robinhood"; }
  if ((a === "cancel" || a === "close") && stageBefore === "connecting") {
    if (kindBefore === "solana" && x.sol) x.sol.live = false;
    if (kindBefore === "robinhood" && x.evm) x.evm.live = false;
  }

  const liveSolAnswer = (a === "phantomApproves" && x.sol?.name === "Phantom" && x.sol.live) || (a === "solflareApproves" && x.sol?.name === "Solflare" && x.sol.live);
  // An EVM answer to the live pick: the wallet's own answer to that pick's prompt (or its network switch), or the pick
  // itself when the wallet was already authorised and answered without a prompt.
  const answerOf = ANSWERS[a] ?? null;
  const liveEvmAnswer = (answerOf !== null && x.evm?.uuid === answerOf && x.evm.live) || (picked?.kind === "robinhood" && x.evm?.live === true);
  const grantedNow = (uuid: string | null) => (uuid === "uuid-a" ? after.aGranted > before.aGranted : uuid === "uuid-b" ? after.bGranted > before.bGranted : false);
  const liveEvmConnect = liveEvmAnswer && grantedNow(x.evm?.uuid ?? null);

  // I1 and I2: connections change only as the answer to the live latest pick of that kind, or by Disconnect.
  if (after.sol !== before.sol) {
    if (after.sol !== null && !(liveSolAnswer && after.sol === x.sol!.name)) return `I1 Solana ${after.sol} connected (was ${before.sol}) on "${a}"`;
    if (after.sol === null && a !== "solDisconnect") return `I2 Solana ${before.sol} disconnected on "${a}"`;
  }
  if (after.evm !== before.evm) {
    const ok = (a === "evmDisconnect" && after.evm === null) || (liveEvmConnect && after.evm === x.evm!.uuid);
    if (!ok) return `I1/I2 EVM chosen ${before.evm} -> ${after.evm} on "${a}"`;
  }
  // R: the remembered EVM wallet follows the connection ("stays connected and remembered").
  if (after.remembered !== before.remembered) {
    const ok = (a === "evmDisconnect" && after.remembered === null) || (liveEvmConnect && after.remembered === RDNS[x.evm!.uuid]);
    if (!ok) return `R remembered ${before.remembered} -> ${after.remembered} on "${a}"`;
  }
  const pickedConnectedSol = stageBefore === "list" && (a === "pickPhantom" || a === "pickSolflare") && before.sol === (a === "pickPhantom" ? "Phantom" : "Solflare");
  // I3: the modal closes only after a connect the person is still waiting for succeeds, or after Close; opens only on open.
  if (stageBefore !== "closed" && after.stage === "closed" && a !== "close") {
    const evmDone = liveEvmAnswer && after.evm === x.evm?.uuid;
    const ok = pickedConnectedSol || (kindBefore === "solana" && stageBefore === "connecting" && liveSolAnswer) || evmDone;
    if (!ok) return `I3 modal closed from "${stageBefore}" on "${a}" (waiting for ${kindBefore})`;
  }
  if (stageBefore === "closed" && after.stage !== "closed" && a !== "open") return `I3 modal opened to "${after.stage}" on "${a}"`;
  // I4: navigation only after a successful pick, to that wallet's side.
  if (after.pushes > before.pushes) {
    const to = m.pushes[m.pushes.length - 1];
    const ok = ((liveSolAnswer || pickedConnectedSol) && to === SOLANA_HOME) || (liveEvmAnswer && after.evm === x.evm?.uuid && to === RH_HOME);
    if (!ok || onSide(pathBefore) === onSide(to!)) return `I4 navigated to ${to} on "${a}"`;
  }
  // I5: only the picked wallet is asked; a network switch only after its accounts or on "Switch network".
  if (after.aReq > before.aReq && !(picked?.id === "uuid-a")) return `I5 Rabby asked for accounts on "${a}"`;
  if (after.bReq > before.bReq && !(picked?.id === "uuid-b")) return `I5 MetaMask asked for accounts on "${a}"`;
  const switchOk = (id: string) => a === "switchNetwork" ? after.evm === id : grantedNow(id) || (id === "uuid-a" ? a === "aApproves" : a === "bApproves");
  if (after.aSwitch > before.aSwitch && !switchOk("uuid-a")) return `I5 Rabby asked to switch on "${a}"`;
  if (after.bSwitch > before.bSwitch && !switchOk("uuid-b")) return `I5 MetaMask asked to switch on "${a}"`;
  if (after.prompted > before.prompted && !(picked?.kind === "solana" && m.prompted[m.prompted.length - 1] === picked.id)) return `I5 ${m.prompted[m.prompted.length - 1]} prompted on "${a}"`;
  // L: the modal waits only on a wallet that has a prompt open.
  const u2 = m.ui();
  if (u2.stage === "connecting") {
    if (u2.pendingKind === "solana") {
      const p = m.adapters[u2.pending as SolName];
      if (!p?.prompt) return `L modal shows "connecting ${u2.pending}" but ${u2.pending} has no prompt open`;
    } else {
      const wal = x.evm ? m.byUuid[x.evm.uuid]! : null;
      if (wal && !wal.prompting && !wal.switchOpen) return `L modal shows "connecting ${u2.pending}" but it has no prompt open`;
    }
  }
  // E1: once the chosen EVM wallet has answered every read, the session shows its current account and network.
  const s = m.session.getSnapshot();
  const cw = s.chosen ? m.byUuid[s.chosen.info.uuid]! : null;
  if (cw && !cw.dead && !cw.readsOpen && !cw.switchOpen) {
    const want = cw.authorised && !cw.locked ? cw.account.toLowerCase() : null;
    if ((s.address?.toLowerCase() ?? null) !== want) return `E1 EVM address ${s.address} but the wallet's account is ${want} after "${a}"`;
    if (s.chainId !== null && s.chainId !== Number.parseInt(cw.chain, 16)) return `E1 EVM chain ${s.chainId} but the wallet is on ${cw.chain} after "${a}"`;
  }
  return null;
}

/** Deterministic PRNG (mulberry32), so a failing sequence is reproducible from its seed. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(opts: Opts, seq: Act[]): Promise<{ at: number; why: string } | null> {
  const m = await mount(opts);
  const x: Model = { sol: null, evm: null, kind: null };
  for (let k = 0; k < seq.length; k++) {
    const why = await step(m, x, seq[k]!);
    if (why) return { at: k, why };
  }
  return null;
}

type Found = { opts: Opts; seq: Act[]; why: string };

async function search(opts: Opts, depth: number, externals: boolean, budget: number, seed: number): Promise<{ found: Map<string, Found>; runs: number; loadAsked: string | null }> {
  const found = new Map<string, Found>();
  const r = rng(seed);
  let runs = 0;
  let loadAsked: string | null = null;
  for (let n = 0; n < budget; n++) {
    const m = await mount(opts);
    // I5 on load: a restore uses eth_accounts only.
    for (const [name, wal] of [["Rabby", m.wa], ["MetaMask", m.wb]] as const) {
      const asked = wal.calls.filter((c) => c === "eth_requestAccounts" || c === "wallet_switchEthereumChain");
      if (asked.length) loadAsked = `I5 ${name} asked ${asked.join(", ")} on load`;
    }
    const x: Model = { sol: null, evm: null, kind: null };
    const seq: Act[] = [];
    runs++;
    for (let k = 0; k < depth; k++) {
      const acts = enabled(m, externals);
      if (!acts.length) break;
      const a = acts[Math.floor(r() * acts.length)]!;
      seq.push(a);
      const why = await step(m, x, a);
      if (why) {
        const key = why.replace(/ (on|after) ".*$/, "").replace(/\(.*\)/, "").replace(/Phantom|Solflare|uuid-a|uuid-b|Rabby|MetaMask|0x[0-9a-fA-F]+|null|\d+/g, "W").slice(0, 60);
        const prev = found.get(key);
        if (!prev || prev.seq.length > seq.length) found.set(key, { opts, seq: [...seq], why });
        break;
      }
    }
  }
  return { found, runs, loadAsked };
}

const START: Opts[] = [
  { path: SOLANA_HOME }, { path: RH_HOME },
  { path: SOLANA_HOME, sol: true }, { path: RH_HOME, sol: true },
  { path: SOLANA_HOME, evm: "uuid-a" }, { path: RH_HOME, evm: "uuid-b" },
  { path: SOLANA_HOME, sol: true, evm: "uuid-b" }, { path: RH_HOME, sol: true, evm: "uuid-a" },
];
const describeStart = (o: Opts) => `start ${o.path}${o.sol ? ", Phantom connected" : ""}${o.evm ? `, ${o.evm === "uuid-a" ? "Rabby" : "MetaMask"} connected` : ""}`;

describe("A2 adversary (b94f89a): search over clicks, Solana and EVM wallet answers and wallet events", () => {
  it("no invariant fails in any sequence of up to 8 steps from any starting state (seeded random search)", async () => {
    const all = new Map<string, Found>();
    const loads: string[] = [];
    let runs = 0;
    const depth = Number(process.env.A2_DEPTH ?? 8);
    const budget = Number(process.env.A2_BUDGET ?? 400);
    // A2_KNOWN=1 leaves out the two kinds pinned by the tests below, to look for others.
    const ignore = process.env.A2_KNOWN ? /^(L modal shows "connecting (Phantom|Solflare)"|I2 Solana)/ : null;
    for (const [k, opts] of START.entries()) {
      for (const externals of [false, true]) {
        const res = await search(opts, depth, externals, budget, 7000 + k * 10 + (externals ? 1 : 0));
        runs += res.runs;
        if (res.loadAsked) loads.push(`${res.loadAsked} (${describeStart(opts)})`);
        for (const [key, f] of res.found) {
          if (ignore?.test(f.why)) continue;
          const prev = all.get(key);
          if (!prev || prev.seq.length > f.seq.length) all.set(key, f);
        }
      }
    }
    const lines = [...loads, ...[...all.values()]
      .sort((p, q) => p.seq.length - q.seq.length)
      .map((f) => `${f.why}\n      ${describeStart(f.opts)}: ${f.seq.join(", ")}`)];
    console.log(`      ${runs} sequences, depth ${depth}`);
    assert.deepEqual(lines, [], `failing sequences (shortest per kind):\n${lines.join("\n")}`);
  }).timeout(600000);
});

describe("A2 adversary (b94f89a): a Solana wallet answers the prompt of a pick the person cancelled", () => {
  it("its late refusal leaves the Solana wallet connected since then connected (late answers from a wallet no longer chosen are dropped)", async () => {
    // Phantom's prompt opens; the person cancels in the modal (the prompt stays open in Phantom: "cannot be withdrawn
    // from here"), picks Solflare and approves it. Then they dismiss the Phantom window still on screen.
    const seq: Act[] = ["open", "pickPhantom", "cancel", "pickSolflare", "solflareApproves", "phantomRefuses"];
    const m = await mount({ path: SOLANA_HOME });
    const x: Model = { sol: null, evm: null, kind: null };
    for (const a of seq.slice(0, 5)) assert.equal(await step(m, x, a), null);
    // (kept with the fix: while Phantom's window is still open the modal refuses any Solana pick, so "pickSolflare"
    // is blocked and says why, instead of selecting Solflare for Phantom's late refusal to deselect. The library then
    // deselecting the failed Phantom is its own cleanup, not a change of connection, so the check compares the
    // connection: connected and key.)
    assert.equal(m.ui().solanaBusy, true, "the Solana pick is blocked while Phantom's request is open");
    const before = { connected: m.sol.connected, key: m.sol.publicKey };
    m.solRefuse("Phantom");
    await settle();
    assert.deepEqual(
      { connected: m.sol.connected, key: m.sol.publicKey },
      before,
      "Phantom's late refusal of the cancelled pick changed the Solana connection",
    );
    assert.equal(m.ui().solanaBusy, false, "once Phantom has answered, Solana wallets can be picked again");
  }).timeout(20000);

  it("its late refusal does not leave the modal waiting on a wallet whose prompt is gone (decision 4)", async () => {
    const m = await mount({ path: SOLANA_HOME });
    const x: Model = { sol: null, evm: null, kind: null };
    for (const a of ["open", "pickSolflare", "cancel", "pickPhantom", "solflareRefuses"] as Act[]) assert.equal(await step(m, x, a), null);
    m.solApprove("Phantom"); // the person approves the pick they are waiting for
    await settle();
    const u = m.ui();
    assert.ok(
      !(u.stage === "connecting" && u.pending === "Phantom" && !m.adapters.Phantom.prompt && !m.sol.connected),
      "Phantom approved the live pick; the modal still says \"Waiting for Phantom\", Phantom has no prompt open and nothing is connected",
    );
  }).timeout(20000);
});

export { run };
