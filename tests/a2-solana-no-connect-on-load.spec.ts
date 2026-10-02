/**
 * Codex code review r9, MAJOR: no wallet request without a click, on the Solana side too. With `autoConnect` on,
 * @solana/wallet-adapter-react 0.15.40 connects a remembered wallet on every page load: its WalletProvider runs
 * `handleAutoConnectRequest` whenever the adapter is set (WalletProvider.js, the effect on [autoConnect, adapter]),
 * and that calls `adapter.autoConnect()` unless `autoConnect` is a function answering false; the base adapter's
 * `autoConnect()` is `connect()` for many wallets. app/src/lib/wallet.tsx now passes a function that answers yes only
 * after a pick in this visit, and on a load only for a Wallet Standard adapter, whose autoConnect is
 * `connect({ silent: true })` (wallet-standard-wallet-adapter-base 1.1.6): returning visitors stay connected without a
 * prompt (Joshua: no forced sign-out), and nothing else connects on a load.
 *
 * Here lib/wallet.tsx is rendered for real (its React hooks, next/navigation and the wallet libraries stubbed, as in
 * tests/a2-modal-search-adversary.spec.ts), and WalletProvider is replaced by a model of exactly that library effect:
 * whenever the selected adapter changes, it asks the `autoConnect` it was given (passing the adapter), and on yes calls
 * `adapter.connect()` if the person selected a wallet (`hasUserSelectedAWallet`) and `adapter.autoConnect()` if not.
 *
 *   npx mocha --import=tsx tests/a2-solana-no-connect-on-load.spec.ts   (installs loader hooks: run it in its own process)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const WALLET_TSX = resolve(SRC, "lib/wallet.tsx");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Hooks = {
  useState(i: unknown): [unknown, (v: unknown) => void];
  useRef(i: unknown): { current: unknown };
  useMemo(f: () => unknown, deps: unknown[]): unknown;
  useCallback(f: unknown, deps: unknown[]): unknown;
  useEffect(f: () => void | (() => void), deps?: unknown[]): void;
  solana(): unknown;
  provider(p: { autoConnect?: unknown }): void;
};
const g = globalThis as { __nl?: Hooks; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const fromWallet = context.parentURL?.endsWith("/lib/wallet.tsx") ?? false;
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (fromWallet && specifier === "react") {
      return stub(
        "const H = () => globalThis.__nl;" +
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
      return stub("export const useRouter = () => ({ push() {} }); export const usePathname = () => '/';");
    }
    if (fromWallet && specifier === "@solana/wallet-adapter-react") {
      return stub(
        "export const useWallet = () => globalThis.__nl.solana(); export const ConnectionProvider = (p) => p.children;" +
        "export const WalletProvider = (p) => { globalThis.__nl.provider(p); return p.children; };",
      );
    }
    if (fromWallet && specifier === "@solana/wallet-adapter-base") return stub("export const WalletReadyState = { Installed: 'Installed' };");
    if (fromWallet && specifier === "@solana/web3.js") return stub("export const clusterApiUrl = () => 'https://api.devnet.solana.com';");
    if (fromWallet && specifier === "@/lib/robinhood/wallet") {
      return stub("export const useEvmWallet = () => ({ wallets: [], connectWith: async () => {}, disconnect: async () => {}, cancelPending() {} });");
    }
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

type Ui = { pick(name: string): void };

/**
 * lib/wallet.tsx with a Solana wallet remembered from an earlier visit (the library restores the selection).
 * Phantom and Solflare come through the Wallet Standard (`standard: true`, a silent autoConnect); "Mobile Wallet
 * Adapter" does not.
 */
async function mount(remembered: "Phantom" | "Mobile Wallet Adapter" | null) {
  g.React = appRequire("react");
  const { WalletProviders } = await import(pathToFileURL(WALLET_TSX).href);

  const asked: { name: string; answer: boolean }[] = [];
  const connected: string[] = []; // every adapter.connect / adapter.autoConnect the library would start
  let selected: string | null = remembered;
  let autoConnect: unknown;
  let lastAdapter: string | null = null;

  const names = ["Phantom", "Solflare", "Mobile Wallet Adapter"];
  const standard = (name: string) => name !== "Mobile Wallet Adapter";
  let userSelected = false; // WalletProvider's hasUserSelectedAWallet: set by select(), never by a restore
  const w = () => ({
    connected: false,
    publicKey: null,
    wallet: selected ? { adapter: { name: selected } } : null,
    wallets: names.map((name) => ({ readyState: "Installed", adapter: { name, icon: "data:image/png;base64,AA==" } })),
    select: (name: string) => { userSelected = true; selected = name; },
    connect: async () => { if (selected) connected.push(`${selected}:connect`); },
    disconnect: async () => { selected = null; },
  });

  const slots: unknown[] = [];
  let i = 0;
  let queued: (() => void)[] = [];
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  const hooks: Hooks = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = init;
      return [slots[k], (v: unknown) => { slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(slots[k]) : v; }];
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
      const prev = slots[k] as { deps?: unknown[] } | undefined;
      if (prev && same(prev.deps, deps)) return;
      queued.push(() => { slots[k] = { deps, cleanup: f() }; });
    },
    solana: () => w(),
    provider: (p) => { autoConnect = p.autoConnect; },
  };

  let ui!: Ui;
  async function render() {
    g.__nl = hooks;
    i = 0;
    queued = [];
    let node = (WalletProviders as (p: { children: null }) => unknown)({ children: null }) as { type: unknown; props: { value?: Ui } };
    while (node.type !== "Provider") node = (node.type as (p: unknown) => unknown)(node.props) as typeof node;
    ui = node.props.value!;
    for (const e of queued) e();
    // WalletProvider 0.15.40 handleAutoConnectRequest: when the selected adapter changes, ask autoConnect with the
    // adapter; on yes, connect() after a user selection, else the adapter's autoConnect() (silent for a standard one).
    if (selected !== lastAdapter) {
      lastAdapter = selected;
      if (selected && autoConnect) {
        const adapter = { name: selected, ...(standard(selected) ? { standard: true } : {}) };
        const answer = autoConnect === true || (typeof autoConnect === "function" && (await (autoConnect as (a: unknown) => Promise<boolean>)(adapter)) === true);
        asked.push({ name: selected, answer });
        if (answer) connected.push(userSelected ? `${selected}:connect` : standard(selected) ? `${selected}:silent` : `${selected}:autoConnect`);
      }
    }
  }
  await render();
  return { asked, connected, autoConnect: () => autoConnect, pick: async (n: string) => { ui.pick(n); await render(); } };
}

describe("A2: no Solana wallet request without a click, and no forced sign-out (Codex r9 MAJOR; Joshua)", function () {
  this.timeout(60_000);

  it("a page load with a remembered standard wallet restores it silently: no prompting connect", async () => {
    const m = await mount("Phantom");
    assert.notEqual(m.autoConnect(), true, "autoConnect is a plain `true`: the library would also auto-connect non-standard adapters on load");
    assert.equal(typeof m.autoConnect(), "function");
    assert.deepEqual(m.asked, [{ name: "Phantom", answer: true }], "the returning visitor is restored");
    assert.deepEqual(m.connected, ["Phantom:silent"], "restored with the adapter's silent autoConnect, never a prompting connect");
  });

  it("a page load with a remembered non-standard adapter (the mobile wallet adapter) connects nothing", async () => {
    const m = await mount("Mobile Wallet Adapter");
    assert.deepEqual(m.asked, [{ name: "Mobile Wallet Adapter", answer: false }]);
    assert.deepEqual(m.connected, [], `a non-standard adapter was connected on page load: ${m.connected.join(", ")}`);
  });

  it("after a pick, the library connects the picked wallet (a pick is still what connects)", async () => {
    const m = await mount(null);
    assert.deepEqual(m.connected, []);
    await m.pick("Solflare");
    assert.deepEqual(m.asked, [{ name: "Solflare", answer: true }]);
    assert.deepEqual(m.connected, ["Solflare:connect"]);
  });

  it("after a pick, a non-standard adapter connects too", async () => {
    const m = await mount(null);
    await m.pick("Mobile Wallet Adapter");
    assert.deepEqual(m.connected, ["Mobile Wallet Adapter:connect"]);
  });
});
