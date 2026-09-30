/**
 * Adversary, A2-SWITCH (othello-design/arb/A2-SWITCH.md, "Rules the code must keep"): "Only the latest intent counts:
 * overlapping connects, a disconnect during an open prompt, and late answers from a wallet no longer chosen are all
 * dropped", and "a refused or failed connect leaves the previous connection unchanged".
 *
 * The modal's state machine (app/src/lib/wallet.tsx) runs here with its real code. The only substitutions: a small
 * hook runtime stands in for React's (so effects and state run in node), the Solana adapter is a fake whose connect
 * the test answers, and useEvmWallet is backed by the real createEvmSession (lib/robinhood/evm-session.ts) over fake
 * EIP-1193 providers. The sequences are clicks the modal offers: a wallet row, Cancel (shown while waiting), Close.
 *
 *   npx mocha --import=tsx tests/a2-cancelled-pick-adversary.spec.ts
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

const A_B = "0x2222222222222222222222222222222222222222";
const A_A = "0x1111111111111111111111111111111111111111";

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
      return stub("export const useWallet = () => globalThis.__a2.solana(); export const ConnectionProvider = (p) => p.children; export const WalletProvider = (p) => p.children;");
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

/** A fake EIP-1193 wallet whose eth_requestAccounts the test answers by hand. */
class Wallet {
  calls: string[] = [];
  private handlers = new Map<string, Set<(x: unknown) => void>>();
  private approve: ((a: string[]) => void) | null = null;
  constructor(private account: string) {}
  request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    this.calls.push(method);
    if (method === "eth_requestAccounts") return new Promise<string[]>((r) => { this.approve = r; });
    if (method === "eth_accounts") return [this.account];
    if (method === "eth_chainId") return "0xb626";
    if (method === "wallet_switchEthereumChain") { this.emit("chainChanged", (params as [{ chainId: string }])[0].chainId); return null; }
    if (method === "wallet_revokePermissions") return null;
    throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
  };
  approveInWallet() { this.approve?.([this.account]); }
  on(ev: string, f: (x: unknown) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(f); }
  removeListener(ev: string, f: (x: unknown) => void) { this.handlers.get(ev)?.delete(f); }
  emit(ev: string, x: unknown) { for (const f of this.handlers.get(ev) ?? []) f(x); }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

type Ui = {
  stage: string;
  pick(name: string): void;
  pickEvm(uuid: string): void;
  cancel(): void;
  close(): void;
  openConnect(): void;
};

/** Mounts the modal's Ui with a minimal hook runtime: state, refs, memo, and effects that run after each render. */
async function mount(evmWallets: EvmWallet[], rememberedRdns: string | null = null) {
  const React = appRequire("react");
  g.React = React;
  const { WalletProviders } = await import(pathToFileURL(WALLET_TSX).href);

  const remembered = { value: rememberedRdns, get: () => remembered.value, set: (v: string) => { remembered.value = v; }, clear: () => { remembered.value = null; } };
  const discovery: Discovery = { list: () => evmWallets, subscribe: () => () => {}, stop: () => {} };
  const session: EvmSession = createEvmSession({ discovery, remembered });

  const solanaState = { connected: false, selected: null as string | null, pendingConnect: false, connectAsked: [] as string[] };
  const pushes: string[] = [];
  let path = "/robinhood";

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
      // (kept with the fix: the hook now also exposes cancelPending, passed straight through to the real session)
      return { wallets: snap.wallets, connectWith: (u: string) => session.connectWith(u), disconnect: () => session.disconnect(), cancelPending: () => session.cancelPending() };
    },
    solana() {
      return {
        connected: solanaState.connected,
        publicKey: null,
        wallet: solanaState.selected ? { adapter: { name: solanaState.selected } } : null,
        wallets: [{ readyState: "Installed", adapter: { name: "Phantom", icon: "data:image/png;base64,AA==" } }],
        // autoConnect: selecting a wallet asks it to connect; the test answers.
        select: (name: string) => { solanaState.selected = name; solanaState.pendingConnect = true; solanaState.connectAsked.push(name); rerender(); },
        connect: async () => { solanaState.pendingConnect = true; },
        disconnect: async () => { solanaState.connected = false; rerender(); },
      };
    },
    router: () => ({ push: (to: string) => { pushes.push(to); path = to; } }),
    pathname: () => path,
  };

  function renderOnce() {
    g.__a2 = hooks;
    i = 0;
    queued = [];
    const el = (WalletProviders as (p: { children: null }) => unknown)({ children: null });
    // WalletProviders -> ConnectionProvider -> WalletProvider -> Ui -> Provider(value)
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
  session.subscribe(rerender);
  rerender();

  return {
    ui: () => ui,
    session,
    remembered,
    pushes,
    solanaApproves: () => { solanaState.pendingConnect = false; solanaState.connected = true; rerender(); },
    solanaConnected: () => solanaState.connected,
  };
}

const evmWallet = (uuid: string, name: string, rdns: string, p: Wallet): EvmWallet =>
  ({ info: { uuid, name, rdns, icon: null }, provider: p as never });

describe("A2 adversary: a cancelled EVM pick answered after the person picked a Solana wallet", () => {
  it("the late EVM approval is dropped: the latest intent was the Solana wallet", async () => {
    const b = new Wallet(A_B);
    const m = await mount([evmWallet("uuid-b", "Rabby", "io.rabby", b)]);

    m.ui().openConnect();
    m.ui().pickEvm("uuid-b"); // click the Rabby row: Rabby's prompt opens
    await settle();
    assert.equal(m.ui().stage, "connecting");
    m.ui().cancel(); // Cancel, shown while waiting: back to the list
    m.ui().pick("Phantom"); // the person now picks Phantom instead
    await settle();

    b.approveInWallet(); // Rabby's old prompt is approved afterwards
    await settle();
    await settle();

    const snap = m.session.getSnapshot();
    assert.equal(
      snap.chosen?.info.name ?? null, null,
      `Rabby was cancelled and Phantom picked after it, yet Rabby is now the connected EVM wallet (address ${snap.address}), ` +
      `remembered as ${m.remembered.value}, and was asked: ${b.calls.join(", ")}`,
    );
  });
});

describe("A2 adversary: cancelling a second EVM pick keeps the wallet already connected", () => {
  it("Cancel then Close, then the wallet approves: the previously connected wallet is still connected", async () => {
    const a = new Wallet(A_A);
    const b = new Wallet(A_B);
    // A is remembered: a reload restores it with eth_accounts, no prompt.
    const m = await mount([evmWallet("uuid-a", "MetaMask", "io.metamask", a), evmWallet("uuid-b", "Rabby", "io.rabby", b)], "io.metamask");
    await settle();
    assert.equal(m.session.getSnapshot().address, A_A, "MetaMask restored");

    m.ui().openConnect();
    m.ui().pickEvm("uuid-b");
    await settle();
    m.ui().cancel();
    m.ui().close();
    b.approveInWallet();
    await settle();
    await settle();

    const snap = m.session.getSnapshot();
    assert.equal(
      snap.address, A_A,
      `the person cancelled Rabby; MetaMask was connected before and must still be, but address is ${snap.address}, ` +
      `chosen ${snap.chosen?.info.name ?? "none"}, remembered ${m.remembered.value}; MetaMask was asked: ${a.calls.join(", ")}`,
    );
  });
});

describe("A2 adversary: control, the harness applies the modal's own Cancel guard", () => {
  it("Cancel then Close with nothing connected before: the late approval is dropped (passes today)", async () => {
    const b = new Wallet(A_B);
    const m = await mount([evmWallet("uuid-b", "Rabby", "io.rabby", b)]);
    m.ui().openConnect();
    m.ui().pickEvm("uuid-b");
    await settle();
    m.ui().cancel();
    m.ui().close();
    b.approveInWallet();
    await settle();
    await settle();
    assert.equal(m.session.getSnapshot().chosen, null);
    assert.deepEqual(m.pushes, []);
  });
});
