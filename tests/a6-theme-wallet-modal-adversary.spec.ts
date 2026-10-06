/**
 * Adversary, A6 theme first paint (Joshua, 2026-10-06), pass on b187f79. The spec: "A returning visitor who has a
 * stored theme ... must see their own palette and mode from the very first painted frame on every page (the shell's
 * inner pages via Shell.tsx, Landing via Landing.tsx, the wallet modal, and anything using ThemeRoot.tsx)".
 *
 * Shell.tsx and Landing.tsx leave their root's inline variables off until the stored theme is read, so the head rules
 * (lib/theme-boot.ts) paint the first frame. The wallet modal does not: WalletConnect.tsx ModalBody calls Shell.tsx
 * useTheme and spreads t.vars onto the overlay's inline style on its first render, and useTheme's first render is its
 * initial state (Bubblegum dark) whatever is stored. Inline variables beat every head rule, so the modal's first frame
 * is the shell's default, then switches once useTheme's effect has read the stored theme.
 *
 * The real WalletConnect.tsx and the real Shell.tsx useTheme are rendered with react-dom/server (React 19.1.1, the
 * app's own), which renders a component's first pass without running effects: the markup a client mount commits
 * before useTheme's load effect. Only the wallet contexts, next/navigation, CSS modules and StockSearch are stubbed,
 * as in tests/a2-modal-render-adversary.spec.ts. The stored theme is written with the repo's own saveTheme and
 * cacheThemeVars, as Shell.tsx does after a visit.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-theme-wallet-modal-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { PALETTES, cacheThemeVars, innerVars, saveTheme } from "../app/src/lib/theme.ts";

const SRC = resolve(REPO, "app/src");
const WALLET_CONNECT = resolve(SRC, "components/othello/WalletConnect.tsx");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Ctx = { ui: Record<string, unknown>; evm: Record<string, unknown>; path: string };
const g = globalThis as unknown as { __a6w?: Ctx; React?: unknown } & Record<string, unknown>;

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (specifier === "./StockSearch") return stub("export default function StockSearch() { return null; }");
    if (specifier === "next/navigation") return stub("export const usePathname = () => globalThis.__a6w.path;");
    if (specifier === "@/lib/wallet") {
      return stub("export const useWalletUi = () => globalThis.__a6w.ui; export const shortAddress = (a) => a;");
    }
    if (specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => globalThis.__a6w.evm;");
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

const noop = () => {};
const ui = {
  address: null, walletName: null, stage: "list", detected: [], evmDetected: [], pending: null, pendingKind: null, solanaBusy: false,
  openConnect: noop, close: noop, pick: noop, pickEvm: noop, cancel: noop, retry: noop, another: noop, recheck: noop, disconnect: noop,
};
const evm = { address: null, onRobinhood: false, walletName: null, error: null, switchToRobinhood: async () => false, disconnect: noop };

/** A browser with the visitor's stored theme, as Shell.tsx leaves it after a visit. */
function browser() {
  const items = new Map<string, string>();
  const appended: { id: string; textContent: string }[] = [];
  g["window"] = globalThis;
  g["localStorage"] = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
  g["document"] = {
    documentElement: { dataset: {}, style: {} },
    head: { appendChild: (s: { id: string; textContent: string }) => void appended.push(s) },
    createElement: () => ({ id: "", textContent: "" }),
    getElementById: (id: string) => appended.find((s) => s.id === id) ?? null,
  };
}

afterEach(() => {
  delete g["window"];
  delete g["localStorage"];
  delete g["document"];
});

/** The overlay's custom properties from its inline style, as the first render commits them. */
function overlayVars(html: string): Record<string, string> {
  const tag = html.match(/<div class="overlay"[^>]*>/)?.[0];
  assert.ok(tag, "precondition: the modal rendered its overlay");
  const style = tag.match(/style="([^"]*)"/)?.[1] ?? "";
  return Object.fromEntries(style.split(";").filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")), d.slice(d.indexOf(":") + 1)]));
}

describe("a6 theme wallet modal, adversary", () => {
  it("a returning visitor's wallet modal opens in their palette and mode, not the shell's default", async () => {
    browser();
    // Harbour in light, stored and cached the way Shell.tsx leaves it.
    const harbour = PALETTES[2]!;
    saveTheme({ choice: "r2", theme: "light", custom: [] });
    cacheThemeVars(harbour, "light");

    const React = appRequire("react");
    g.React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const mod = await import(pathToFileURL(WALLET_CONNECT).href);
    g.__a6w = { ui, evm, path: "/portfolio" };
    const vars = overlayVars(renderToStaticMarkup(React.createElement(mod.WalletModal, {})));

    const mine = innerVars(harbour, false);
    const shellDefault = innerVars(PALETTES[1]!, true);
    // Either the overlay sets no inline palette on its first frame (the head rules paint it), or it sets the visitor's.
    for (const name of ["--panel", "--desk", "--acid", "--onPanel"]) {
      if (vars[name] === undefined) continue;
      assert.notEqual(vars[name], shellDefault[name], `${name} is Bubblegum dark (the shell's default) on the modal's first frame`);
      assert.equal(vars[name], mine[name], `${name} is the visitor's Harbour light`);
    }
  });
});
