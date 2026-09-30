/**
 * Adversary, A2-SWITCH (othello-design/arb/A2-SWITCH.md). A search over the connect modal's clicks and the wallets'
 * answers, checking after every step the rules the spec states for the modal (app/src/lib/wallet.tsx):
 *
 *   I1  a wallet becomes connected only as the answer to the person's latest pick of that kind, not cancelled or closed
 *   I2  a cancelled, closed or superseded pick never changes any connection ("the wallet already connected, if any,
 *       stays connected")
 *   I3  the modal closes only after a connect the person is still waiting for succeeds, or after Close; it opens only
 *       on "Connect wallet"
 *   I4  the app navigates only after a successful pick, to that wallet's side (decision 4, destinationAfterConnect)
 *   I5  only the picked wallet is asked for anything
 *   L   decision 4, "Picking a wallet connects it and takes the person to that wallet's side": a pick never leaves the
 *       modal waiting on a wallet that has no prompt open
 *
 * Harness: the hook runtime of tests/a2-closed-solana-reopened-adversary.spec.ts (real wallet.tsx, real
 * createEvmSession over fake EIP-1193 wallets), with the fake Solana provider made faithful to
 * @solana/wallet-adapter-react 0.15.40 on the points the modal depends on:
 *   - `useWallet()` returns the object WalletProviderBase builds when *it* renders (WalletProviderBase.js, the
 *     WalletContext.Provider value). Ui's own setState does not re-render the provider, so the object's identity
 *     changes only when the provider's state changes (connected, publicKey, connecting, wallet). The earlier harnesses
 *     built a new `w` (and a new router) on every render, which re-ran the `w.connected` effect on every click.
 *   - `connect()` returns without asking the wallet when a connect is in flight or the adapter is already connected
 *     (WalletProviderBase.js handleConnect: `if (isConnectingRef.current || isDisconnectingRef.current ||
 *     wallet?.adapter.connected) return;`).
 *   - `select(other)` disconnects the adapter selected before (WalletProvider.js changeWallet) and autoConnect asks
 *     the new one; a refusal from the selected wallet reaches onError, then deselects it (handleConnectError).
 *   - a Standard wallet whose first account changes re-emits `connect` with the new key
 *     (wallet-standard-wallet-adapter-base adapter.js, `#changed`), so publicKey changes and `w` is rebuilt.
 *   - `useRouter()` is stable (Next's AppRouterContext value is memoised).
 *
 *   npx mocha --import=tsx tests/a2-modal-search-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import type { Discovery, EvmWallet } from "../app/src/lib/robinhood/eip6963.ts";
import { createEvmSession, type EvmSession } from "../app/src/lib/robinhood/evm-session.ts";

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

/** A fake EIP-1193 wallet: eth_requestAccounts waits for the test; the network switch is accepted or refused (4001). */
class Wallet {
  calls: string[] = [];
  private handlers = new Map<string, Set<(x: unknown) => void>>();
  private waiting: { ok: (a: string[]) => void; no: (e: unknown) => void }[] = [];
  constructor(private account: string, private refusesSwitch: boolean) {}
  request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    this.calls.push(method);
    if (method === "eth_requestAccounts") return new Promise<string[]>((ok, no) => { this.waiting.push({ ok, no }); });
    if (method === "eth_accounts") return [this.account];
    if (method === "eth_chainId") return "0x1";
    if (method === "wallet_switchEthereumChain") {
      if (this.refusesSwitch) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      this.emit("chainChanged", (params as [{ chainId: string }])[0].chainId);
      return null;
    }
    if (method === "wallet_revokePermissions") return null;
    throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
  };
  get prompting() { return this.waiting.length > 0; }
  approve() { const w = this.waiting; this.waiting = []; for (const x of w) x.ok([this.account]); }
  refuse() { const w = this.waiting; this.waiting = []; for (const x of w) x.no(Object.assign(new Error("User rejected the request."), { code: 4001 })); }
  on(ev: string, f: (x: unknown) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(f); }
  removeListener(ev: string, f: (x: unknown) => void) { this.handlers.get(ev)?.delete(f); }
  emit(ev: string, x: unknown) { for (const f of this.handlers.get(ev) ?? []) f(x); }
}

const settle = async () => { for (let k = 0; k < 4; k++) await new Promise((r) => setImmediate(r)); };

type Ui = {
  stage: string;
  pending: string | null;
  pendingKind: string | null;
  address: string | null;
  pick(name: string): void;
  pickEvm(uuid: string): void;
  cancel(): void;
  close(): void;
  openConnect(): void;
  retry(): void;
  another(): void;
};

type SolName = "Phantom" | "Solflare";
type Opts = { path: string; restoredPhantom?: boolean };

async function mount(opts: Opts) {
  const React = appRequire("react");
  g.React = React;
  const { WalletProviders } = await import(pathToFileURL(WALLET_TSX).href);

  const wa = new Wallet("0x1111111111111111111111111111111111111111", false);
  const wb = new Wallet("0x2222222222222222222222222222222222222222", true);
  const evmWallets: EvmWallet[] = [
    { info: { uuid: "uuid-a", name: "Rabby", rdns: "io.rabby", icon: null }, provider: wa as never },
    { info: { uuid: "uuid-b", name: "MetaMask", rdns: "io.metamask", icon: null }, provider: wb as never },
  ];
  const remembered = { value: null as string | null, get: () => remembered.value, set: (v: string) => { remembered.value = v; }, clear: () => { remembered.value = null; } };
  const discovery: Discovery = { list: () => evmWallets, subscribe: () => () => {}, stop: () => {} };
  const session: EvmSession = createEvmSession({ discovery, remembered });

  // The Solana provider, as WalletProvider + WalletProviderBase + StandardWalletAdapter behave (see the header).
  const adapters: Record<SolName, { connected: boolean; prompt: boolean; account: number }> = {
    Phantom: { connected: false, prompt: false, account: 1 },
    Solflare: { connected: false, prompt: false, account: 1 },
  };
  const sol = { selected: null as SolName | null, connected: false, publicKey: null as string | null, isConnecting: false };
  const prompted: string[] = [];
  if (opts.restoredPhantom) {
    adapters.Phantom.connected = true;
    Object.assign(sol, { selected: "Phantom", connected: true, publicKey: "Phantom#1" });
  }
  const walletsList = (["Phantom", "Solflare"] as const).map((name) => ({ readyState: "Installed", adapter: { name, icon: "data:image/png;base64,AA==" } }));
  const openPrompt = (name: SolName) => {
    const a = adapters[name];
    if (a.connected || a.prompt) return; // StandardWalletAdapter.connect: `if (this.connected || this.connecting) return;`
    a.prompt = true;
    prompted.push(name);
    sol.isConnecting = true;
  };
  let w: unknown;
  const buildW = () => {
    w = {
      connected: sol.connected,
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
    a.connected = true;
    if (sol.selected !== name) return; // listeners of a deselected adapter are gone
    Object.assign(sol, { connected: true, publicKey: `${name}#${a.account}`, isConnecting: false });
    changed();
  };
  const solRefuse = (name: SolName) => {
    const a = adapters[name];
    if (!a.prompt) return;
    a.prompt = false;
    if (sol.selected !== name) return; // conservative: a deselected adapter's refusal is ignored
    sol.isConnecting = false;
    const inner = Object.assign(new Error("User rejected the request."), { code: 4001 });
    g.__a2!.onError?.(Object.assign(new Error("User rejected the request."), { name: "WalletConnectionError", error: inner }));
    Object.assign(sol, { selected: null, connected: false, publicKey: null }); // handleConnectError: changeWallet(null)
    changed();
  };
  /** The person switches account inside the wallet: the adapter re-emits connect with the new key. */
  const solSwitchAccount = (name: SolName) => {
    const a = adapters[name];
    if (!a.connected || sol.selected !== name) return;
    a.account++;
    sol.publicKey = `${name}#${a.account}`;
    changed();
  };

  return {
    ui: () => ui,
    session,
    wa, wb,
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
  | "phantomApproves" | "phantomRefuses" | "solflareApproves" | "solflareRefuses"
  | "aApproves" | "aRefuses" | "bApproves" | "bRefuses" | "phantomSwitchesAccount";

const SOLANA_HOME = "/";
const RH_HOME = "/robinhood";
const onSide = (p: string) => (p === RH_HOME || p.startsWith(`${RH_HOME}/`) ? "robinhood" : "solana");

/** What the person has asked for, kept by the test. */
type Model = { sol: { name: string; live: boolean } | null; evm: { uuid: string; live: boolean } | null; kind: "solana" | "robinhood" | null };

function enabled(m: M, x: Model, externals: boolean): Act[] {
  const u = m.ui();
  const acts: Act[] = [];
  if (u.stage === "closed") {
    const side = onSide(m.path());
    const button = side === "solana" ? !m.sol.connected : !m.session.getSnapshot().address;
    if (button) acts.push("open");
    acts.push("switchSide");
  }
  if (u.stage === "list") acts.push("pickPhantom", "pickSolflare", "pickA", "pickB");
  if (u.stage === "connecting") acts.push("cancel");
  if (u.stage !== "closed") acts.push("close");
  if (u.stage === "rejected" || u.stage === "failed") acts.push("retry", "another");
  if (m.adapters.Phantom.prompt) acts.push("phantomApproves", "phantomRefuses");
  if (m.adapters.Solflare.prompt) acts.push("solflareApproves", "solflareRefuses");
  if (m.wa.prompting) acts.push("aApproves", "aRefuses");
  if (m.wb.prompting) acts.push("bApproves", "bRefuses");
  if (externals && m.sol.connected) acts.push("phantomSwitchesAccount");
  void x;
  return acts;
}

type Snap = { stage: string; sol: string | null; evm: string | null; pushes: number; aReq: number; bReq: number; prompted: number; aSwitch: number; bSwitch: number };
const count = (calls: string[], m: string) => calls.filter((c) => c === m).length;
function snap(m: M): Snap {
  return {
    stage: m.ui().stage,
    sol: m.sol.connected ? m.sol.selected : null,
    evm: m.session.getSnapshot().chosen?.info.uuid ?? null,
    pushes: m.pushes.length,
    aReq: count(m.wa.calls, "eth_requestAccounts"), bReq: count(m.wb.calls, "eth_requestAccounts"),
    aSwitch: count(m.wa.calls, "wallet_switchEthereumChain"), bSwitch: count(m.wb.calls, "wallet_switchEthereumChain"),
    prompted: m.prompted.length,
  };
}

async function step(m: M, x: Model, a: Act): Promise<string | null> {
  const before = snap(m);
  const kindBefore = x.kind;
  const stageBefore = before.stage;
  const u = m.ui();
  const pathBefore = m.path();
  // What the person asked, recorded before the step.
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
    case "phantomApproves": m.solApprove("Phantom"); break;
    case "phantomRefuses": m.solRefuse("Phantom"); break;
    case "solflareApproves": m.solApprove("Solflare"); break;
    case "solflareRefuses": m.solRefuse("Solflare"); break;
    case "aApproves": m.wa.approve(); break;
    case "aRefuses": m.wa.refuse(); break;
    case "bApproves": m.wb.approve(); break;
    case "bRefuses": m.wb.refuse(); break;
    case "phantomSwitchesAccount": m.solSwitchAccount("Phantom"); break;
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
  const evmAnswerOf = a === "aApproves" ? "uuid-a" : a === "bApproves" ? "uuid-b" : null;
  const liveEvmAnswer = evmAnswerOf !== null && x.evm?.uuid === evmAnswerOf && x.evm.live;

  // I1 and I2: connections change only as the answer to the live latest pick of that kind.
  if (after.sol !== before.sol) {
    if (after.sol !== null && !(liveSolAnswer && after.sol === x.sol!.name)) return `I1 Solana ${after.sol} connected (was ${before.sol}) on "${a}"`;
    if (after.sol === null && !picked) return `I2 Solana ${before.sol} disconnected on "${a}"`;
    if (after.sol === null && picked) return `I2-lib Solana ${before.sol} disconnected by picking ${picked.id} (WalletProvider changeWallet)`;
  }
  if (a === "phantomSwitchesAccount" && after.sol === null && before.sol !== null) return `I2 Solana ${before.sol} disconnected on "${a}"`;
  if (after.evm !== before.evm) {
    if (!(liveEvmAnswer && after.evm === x.evm!.uuid)) return `I1/I2 EVM chosen ${before.evm} -> ${after.evm} on "${a}"`;
  }
  // (kept with the fix: picking the Solana wallet that is already connected is an immediate success, as this file's
  // own "connects it and takes the person to the Solana side" case expects: it may close the modal from the list and go
  // to the Solana side)
  const pickedConnectedSol = stageBefore === "list" && (a === "pickPhantom" || a === "pickSolflare") && before.sol === (a === "pickPhantom" ? "Phantom" : "Solflare");
  // I3: the modal closes only after a connect the person is still waiting for succeeds, or after Close; opens only on open.
  if (stageBefore !== "closed" && after.stage === "closed" && a !== "close") {
    const ok = pickedConnectedSol || (stageBefore === "connecting" && ((kindBefore === "solana" && liveSolAnswer) || (kindBefore === "robinhood" && liveEvmAnswer)));
    if (!ok) return `I3 modal closed from "${stageBefore}" on "${a}" (waiting for ${kindBefore})`;
  }
  if (stageBefore === "closed" && after.stage !== "closed" && a !== "open") return `I3 modal opened to "${after.stage}" on "${a}"`;
  // I4: navigation only after a successful pick, to that wallet's side.
  if (after.pushes > before.pushes) {
    const to = m.pushes[m.pushes.length - 1];
    const ok = ((liveSolAnswer || pickedConnectedSol) && to === SOLANA_HOME) || (liveEvmAnswer && to === RH_HOME);
    if (!ok || onSide(pathBefore) === onSide(to!)) return `I4 navigated to ${to} on "${a}"`;
  }
  // I5: only the picked wallet is asked.
  if (after.aReq > before.aReq && !(picked?.id === "uuid-a")) return `I5 Rabby asked for accounts on "${a}"`;
  if (after.bReq > before.bReq && !(picked?.id === "uuid-b")) return `I5 MetaMask asked for accounts on "${a}"`;
  if (after.aSwitch > before.aSwitch && a !== "aApproves") return `I5 Rabby asked to switch on "${a}"`;
  if (after.bSwitch > before.bSwitch && a !== "bApproves") return `I5 MetaMask asked to switch on "${a}"`;
  if (after.prompted > before.prompted && !(picked?.kind === "solana" && m.prompted[m.prompted.length - 1] === picked.id)) return `I5 ${m.prompted[m.prompted.length - 1]} prompted on "${a}"`;
  // L: a pick leaves the modal waiting only on a wallet that has a prompt open (or is settling its network switch).
  const u2 = m.ui();
  if (u2.stage === "connecting") {
    const waitingOn = u2.pendingKind === "solana" ? m.adapters[u2.pending as SolName]?.prompt : true;
    if (!waitingOn) return `L modal shows "connecting ${u2.pending}" but ${u2.pending} has no prompt open`;
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

async function search(opts: Opts, depth: number, externals: boolean, budget: number, seed: number): Promise<{ found: Map<string, Found>; runs: number }> {
  const found = new Map<string, Found>();
  const r = rng(seed);
  let runs = 0;
  for (let n = 0; n < budget; n++) {
    const m = await mount(opts);
    const x: Model = { sol: null, evm: null, kind: null };
    const seq: Act[] = [];
    runs++;
    for (let k = 0; k < depth; k++) {
      const acts = enabled(m, x, externals);
      if (!acts.length) break;
      const a = acts[Math.floor(r() * acts.length)]!;
      seq.push(a);
      const why = await step(m, x, a);
      if (why) {
        const key = why.replace(/ on ".*$/, "").replace(/\(.*\)/, "").replace(/Phantom|Solflare|uuid-a|uuid-b|Rabby|MetaMask/g, "W").slice(0, 60);
        const prev = found.get(key);
        if (!prev || prev.seq.length > seq.length) found.set(key, { opts, seq: [...seq], why });
        if (!process.env.A2_CONTINUE) break;
      }
    }
  }
  return { found, runs };
}

describe("A2 adversary: search over the connect modal's clicks and the wallets' answers", () => {
  it("no invariant fails in any sequence of up to 6 steps (seeded random search)", async () => {
    const all = new Map<string, Found>();
    let runs = 0;
    const depth = Number(process.env.A2_DEPTH ?? 6);
    const budget = Number(process.env.A2_BUDGET ?? 1500);
    const ignore = process.env.A2_IGNORE ? new RegExp(process.env.A2_IGNORE) : null;
    for (const [k, opts] of ([{ path: RH_HOME }, { path: SOLANA_HOME }, { path: RH_HOME, restoredPhantom: true }] as Opts[]).entries()) {
      for (const externals of [false, true]) {
        const res = await search(opts, depth, externals, budget, 1000 + k * 10 + (externals ? 1 : 0));
        runs += res.runs;
        for (const [key, f] of res.found) {
          if (ignore?.test(f.why)) continue;
          const prev = all.get(key);
          if (!prev || prev.seq.length > f.seq.length) all.set(key, f);
        }
      }
    }
    const lines = [...all.values()]
      .sort((p, q) => p.seq.length - q.seq.length)
      .map((f) => `${f.why}\n      start ${f.opts.path}${f.opts.restoredPhantom ? " with Phantom restored" : ""}: ${f.seq.join(", ")}`);
    console.log(`      ${runs} sequences`);
    assert.deepEqual(lines, [], `failing sequences (shortest per kind):\n${lines.join("\n")}`);
  }).timeout(120000);
});

describe("A2 adversary: picking the Solana wallet that is already connected, from the Robinhood side", () => {
  it("connects it and takes the person to the Solana side (decision 4), instead of waiting forever", async () => {
    const m = await mount({ path: RH_HOME });
    // Phantom is connected from an earlier pick; the person then goes to Robinhood Chain (the switch), where the top
    // bar shows "Connect wallet" because no EVM wallet is connected, and that one modal lists Phantom.
    const x: Model = { sol: null, evm: null, kind: null };
    for (const a of ["open", "pickPhantom", "phantomApproves", "switchSide", "open"] as Act[]) assert.equal(await step(m, x, a), null);
    assert.equal(m.path(), RH_HOME);
    assert.equal(m.sol.connected, true);
    m.ui().pick("Phantom");
    await settle();
    assert.deepEqual(
      { stage: m.ui().stage, path: m.path(), phantomPromptOpen: m.adapters.Phantom.prompt },
      { stage: "closed", path: SOLANA_HOME, phantomPromptOpen: false },
      "the modal is left on \"connecting Phantom\" with no prompt open in Phantom, and nothing navigates",
    );
  }).timeout(20000);

  it("Close on that stuck screen does not disconnect Phantom later (a closed pick never changes any connection)", async () => {
    const m = await mount({ path: RH_HOME });
    const x: Model = { sol: null, evm: null, kind: null };
    for (const a of ["open", "pickPhantom", "phantomApproves", "switchSide", "open", "pickPhantom"] as Act[]) await step(m, x, a);
    m.ui().close(); // the person gives up on the screen that never moves
    await settle();
    assert.equal(m.sol.connected, true);
    m.solSwitchAccount("Phantom"); // later, in Phantom, the person switches to another account
    await settle();
    assert.equal(m.sol.connected, true, "Phantom was connected before the closed pick and must stay connected; it was disconnected");
  }).timeout(20000);
});

describe("A2 adversary: picking another Solana wallet while one is connected (reachable from the Robinhood side)", () => {
  it("a refused pick leaves the Solana wallet connected before it connected (\"a refused or failed connect leaves the previous connection unchanged\")", async () => {
    const m = await mount({ path: RH_HOME, restoredPhantom: true });
    m.ui().openConnect();
    m.ui().pick("Solflare");
    await settle();
    m.solRefuse("Solflare");
    await settle();
    assert.deepEqual({ connected: m.sol.connected, wallet: m.sol.selected }, { connected: true, wallet: "Phantom" }, "Solflare refused, and Phantom, connected before, is gone");
  }).timeout(20000);
});

describe("A2 adversary: the Solana wallet changes while an EVM wallet's prompt is open", () => {
  it("the modal stays open on the EVM connect the person is waiting for", async () => {
    const m = await mount({ path: RH_HOME, restoredPhantom: true });
    m.ui().openConnect();
    m.ui().pickEvm("uuid-a"); // Rabby's prompt opens
    await settle();
    m.solSwitchAccount("Phantom"); // Phantom, connected since the reload, reports another account
    await settle();
    assert.equal(m.wa.prompting, true);
    assert.equal(m.ui().stage, "connecting", "the modal closed while Rabby's prompt is still open");
  }).timeout(20000);
});
