/**
 * Adversary, A2 chain logos (Joshua, 2026-10-03), pass on 8e2f834. The spec: "The top bar shows only the active chain's
 * official logo (none with no wallet). Robinhood Chain's feather ... must be visible and correct in both of the site's
 * themes, whatever theme the person picked, on whichever page, including after moving between the landing page (/) and
 * the other pages without a reload."
 *
 * The real app/src/app/page.tsx (the landing page, /) is rendered with react-dom/server (the app's own React) over
 * stubbed wallet contexts with only an EVM wallet connected, so the active side is Robinhood Chain (lib/side-rules.ts
 * activeSide). Its top bar (Landing's <header>) is then searched for the feather, as the real ChainMark draws it. The
 * reference path is the real ChainMark's, which matches cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/
 * feather-dark.svg path for path (fetched 2026-10-03).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-chain-mark-landing-adversary.spec.ts
 *
 * Installs module loader hooks: run in its own mocha process.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "app/page.tsx");
const SHELL = resolve(SRC, "components/othello/Shell.tsx");
const CHAIN_MARK = resolve(SRC, "components/othello/ChainMark.tsx");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Ctx = { ui: Record<string, unknown>; evm: Record<string, unknown>; path: string };
const g = globalThis as { __a2l?: Ctx; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (specifier === "@/components/othello/WalletConnect" || specifier === "./WalletConnect") {
      return stub("export function WalletControl() { return null; }");
    }
    if (specifier === "./StockSearch") return stub("export default function StockSearch() { return null; }");
    if (specifier === "next/navigation") return stub("export const usePathname = () => globalThis.__a2l.path;");
    if (specifier === "@/lib/wallet") return stub("export const useWalletUi = () => globalThis.__a2l.ui;");
    if (specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => globalThis.__a2l.evm;");
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

async function render(file: string, ctx: Ctx, props: Record<string, unknown> = {}, child?: unknown): Promise<string> {
  const React = appRequire("react");
  g.React = React;
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const mod = await import(pathToFileURL(file).href);
  g.__a2l = ctx;
  return renderToStaticMarkup(React.createElement(mod.default, props, child));
}

const noop = () => {};
const ui = { address: null, walletName: null, stage: "closed", openConnect: noop, disconnect: noop };
const evm = { address: "0x1111111111111111111111111111111111111111", onRobinhood: true, walletName: "MetaMask", disconnect: noop };

/** The feather's path data, as the real ChainMark draws it. */
async function featherD(): Promise<string> {
  const html = await render(CHAIN_MARK, { path: "/robinhood", ui, evm }, { side: "robinhood" });
  const d = /<path class="feather" d="([^"]+)"/.exec(html)?.[1];
  assert.ok(d, "precondition: ChainMark draws the feather for Robinhood Chain");
  return d;
}

describe("A2 adversary (8e2f834): the landing page's top bar and the active chain's mark", () => {
  it("control: on /robinhood the Shell's top bar shows the feather with only MetaMask connected", async () => {
    const d = await featherD();
    const html = await render(SHELL, { path: "/robinhood", ui, evm }, { active: "Circles" }, null);
    assert.ok(html.includes(`d="${d}"`), "the Shell's top bar draws the feather");
  });

  it("only MetaMask, on the landing page (/): its top bar shows Robinhood Chain's feather", async () => {
    const d = await featherD();
    const html = await render(PAGE, { path: "/", ui, evm });
    const header = /<header class="nav">([\s\S]*?)<\/header>/.exec(html)?.[1];
    assert.ok(header, "precondition: the landing page renders its top bar (<header class=nav>)");
    assert.ok(html.includes("Showing Robinhood Chain testnet"), "precondition: the landing page knows the active side is Robinhood Chain");
    assert.ok(
      header.includes(`d="${d}"`),
      "the landing page's top bar with only MetaMask connected has no Robinhood Chain feather: the active chain's mark is missing on /",
    );
  });

  it("only a Solana wallet, on an asset page (/assets): its top bar shows Solana's mark", async () => {
    // the asset pages' frame (components/assets/Shell.tsx), as /assets renders it once RouteGate lets a Solana wallet in
    const sol = { ...ui, address: "So11111111111111111111111111111111111111112", walletName: "Phantom" };
    const none = { ...evm, address: null };
    const html = await render(resolve(SRC, "components/assets/Shell.tsx"), { path: "/assets", ui: sol, evm: none }, { back: { href: "/", label: "Home" } }, null);
    const topbar = /<div class="topbar">([\s\S]*?)<\/main>/.exec(html)?.[1];
    assert.ok(topbar, "precondition: the Shell renders its top bar");
    assert.ok(topbar.includes("Mainnet, read only"), "precondition: this is the asset pages' top bar, with their own chip");
    assert.ok(
      topbar.includes('stop-color="#9945FF"'),
      "the asset page's top bar with only a Solana wallet connected shows no chain mark",
    );
  });
});
