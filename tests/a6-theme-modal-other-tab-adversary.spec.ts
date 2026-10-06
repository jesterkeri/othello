/**
 * Adversary, A6 theme first paint (Joshua, 2026-10-06), pass on 24e044d. The spec: "Picker changes and changes from
 * another tab still take effect; a surface that mounts after a client-side navigation or later in the session opens
 * in the current choice", and a returning visitor "sees their own palette and mode from the very first painted frame
 * on every page and surface (... the connect-wallet modal in WalletConnect.tsx ...)".
 *
 * Since 24e044d the wallet modal's overlay carries no inline palette until Shell.tsx useTheme has read the stored
 * theme: its first frame takes the head rules ([data-tk=inner]) that cacheThemeVars keeps current. Shell.tsx keeps
 * them current when another tab changes the theme (its storage listener re-caches), but Landing.tsx has no storage
 * listener, so on the home page the head rules stay at the palette Landing last cached. A visitor with Othello open
 * in two tabs who picks a palette in one, then clicks Connect wallet on the home page in the other, gets a modal
 * whose first frame is the old palette; its own useTheme then reads the stored (new) one and switches.
 *
 * The real Landing.tsx, WalletConnect.tsx and Shell.tsx useTheme are bundled with esbuild and mounted with
 * react-dom/client (React 19.1.1, the app's own) in a real Chromium, under the head rules and head script layout.tsx
 * renders (lib/theme-boot.ts). Only the wallet contexts, next/navigation, the explorer link and CSS modules are stubbed,
 * as in tests/a6-theme-wallet-modal-adversary.spec.ts. The other tab is what the browser delivers for one: its writes
 * to localStorage (the shape saveTheme and cacheThemeVars write) and a storage event on this window. The modal is
 * opened with flushSync, which commits its first render and runs its effects, but leaves the re-render those effects
 * ask for to a later task: what is read right after flushSync is the frame before the stored theme is read.
 * Browser: $CHROME, else Playwright's cached chrome-headless-shell.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-theme-modal-other-tab-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { PALETTES, innerVars, themeVars } from "../app/src/lib/theme.ts";
import { cssVars, paintStoredTheme, screenDefaults } from "../app/src/lib/theme-boot.ts";

const SRC = resolve(REPO, "app/src");
/** tsx's own esbuild (the root has no esbuild of its own, nor its types): the few members used here. */
type Resolved = { path: string; namespace?: string; pluginData?: unknown } | undefined;
type PluginBuild = {
  onResolve(o: { filter: RegExp }, f: (a: { path: string }) => Resolved): void;
  onLoad(o: { filter: RegExp; namespace: string }, f: (a: { pluginData: unknown }) => { contents: string; loader: string }): void;
};
type Esbuild = { build(o: Record<string, unknown> & { plugins: { name: string; setup(b: PluginBuild): void }[] }): Promise<{ outputFiles: { text: string }[] }> };
const esbuild = createRequire(createRequire(import.meta.url).resolve("tsx"))("esbuild") as Esbuild;

/** Browsers: $CHROME, Playwright's cached chrome-headless-shell, then Windows Chrome under WSL (as tests/a5-ring-logo-adversary.spec.ts). */
function browsers(): { bin: string; windows: boolean }[] {
  const out: { bin: string; windows: boolean }[] = [];
  if (process.env.CHROME) out.push({ bin: process.env.CHROME, windows: process.env.CHROME.endsWith(".exe") });
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const d of existsSync(cache) ? readdirSync(cache) : []) {
    const bin = join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (d.startsWith("chromium_headless_shell") && existsSync(bin)) out.push({ bin, windows: false });
  }
  const win = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
  if (existsSync(win)) out.push({ bin: win, windows: true });
  return out;
}

/** A path as the browser sees it: a Windows browser under WSL reads WSL files through \\wsl.localhost. */
function forBrowser(path: string, windows: boolean): string {
  if (!windows) return path;
  const w = spawnSync("wslpath", ["-w", path], { encoding: "utf8" }).stdout.trim();
  assert.ok(w, `wslpath gave nothing for ${path}`);
  return w;
}

/** The page script: Landing and the wallet modal, as layout.tsx and app/page.tsx mount them. */
const ENTRY = `
import { createElement as h, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import Landing from "@/components/landing/Landing";
import { WalletModal } from "@/components/othello/WalletConnect";
import { PALETTES, STORAGE_KEY, VARS_KEY, innerVars, themeVars } from "@/lib/theme";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, what) => { for (let i = 0; i < 300; i++) { if (ok()) return; await sleep(10); } throw new Error("timed out: " + what); };
const panel = (sel, name = "--panel") => { const el = document.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue(name).trim().toLowerCase() : null; };

async function main() {
  const out = {};
  try {
    const root = createRoot(document.getElementById("root"));
    const App = () => h(Fragment, null, h(Landing, { onConnectWallet: () => {} }), h(WalletModal));
    flushSync(() => root.render(h(App)));
    // Landing has read the stored theme, saved it and cached it (its root carries its own variables from then on)
    await until(() => document.querySelector("[data-tk=landing]")?.getAttribute("style"), "Landing read the stored theme");
    await sleep(200);
    out.landingBefore = panel("[data-tk=landing]", "--desk");

    // Another tab picks Newsprint dark: its saveTheme, then its cacheThemeVars, then the browser's storage event here.
    const old = localStorage.getItem(STORAGE_KEY);
    const next = JSON.stringify({ choice: "r3", theme: "dark", custom: [] });
    localStorage.setItem(STORAGE_KEY, next);
    localStorage.setItem(VARS_KEY, JSON.stringify({ key: next, mode: "dark", inner: innerVars(PALETTES[3], true), landing: themeVars(PALETTES[3], true) }));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, oldValue: old, newValue: next, storageArea: localStorage }));
    await sleep(200);

    // Connect wallet on the home page.
    globalThis.__a6t.ui.stage = "list";
    flushSync(() => root.render(h(App)));
    out.modalFirst = panel("[data-tk=inner]");
    // the modal's useTheme has read the stored theme (the overlay carries its own variables from then on)
    await until(() => document.querySelector("[data-tk=inner]")?.getAttribute("style"), "the modal read the stored theme");
    out.modalSettled = panel("[data-tk=inner]");
    out.storedAtEnd = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    out.error = String(e && e.stack || e);
  }
  const pre = document.createElement("pre");
  pre.id = "a6-out";
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
}
main();
`;

/** Bundles ENTRY with the app's real components, stubbing what needs a wallet or a Next router. */
async function bundle(): Promise<string> {
  const stubs: Record<string, string> = {
    "next/navigation": "export const usePathname = () => '/'; export const useRouter = () => ({ push() {}, replace() {}, prefetch() {} });",
    "@/lib/wallet": "export const useWalletUi = () => globalThis.__a6t.ui; export const shortAddress = (a) => a;",
    "@/lib/robinhood/wallet": "export const useEvmWallet = () => globalThis.__a6t.evm;",
    "@/lib/robinhood/chain": "export const explorerAddress = (a) => String(a);",
    "./StockSearch": "export default function StockSearch() { return null; }",
  };
  const r = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: SRC, loader: "jsx" },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    nodePaths: [resolve(REPO, "app/node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
    plugins: [{
      name: "a6-stubs",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.path.endsWith(".module.css")) return { path: a.path, namespace: "stub", pluginData: "export default new Proxy({}, { get: (_, k) => String(k) });" };
          if (a.path in stubs) return { path: a.path, namespace: "stub", pluginData: stubs[a.path] };
          if (a.path.startsWith("@/")) {
            const base = resolve(SRC, a.path.slice(2));
            for (const ext of [".ts", ".tsx", "/index.ts"]) if (existsSync(base + ext)) return { path: base + ext };
          }
          return undefined;
        });
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData as string, loader: "js" }));
      },
    }],
  });
  return r.outputFiles[0]!.text;
}

/** The document layout.tsx renders: its head rules and head script, then the page. */
function page(): string {
  const noop = "() => {}";
  const ui = `{ address: null, walletName: null, stage: "closed", detected: [], evmDetected: [], pending: null, pendingKind: null, solanaBusy: false,
    openConnect: ${noop}, close: ${noop}, pick: ${noop}, pickEvm: ${noop}, cancel: ${noop}, retry: ${noop}, another: ${noop}, recheck: ${noop}, disconnect: ${noop} }`;
  const evm = `{ address: null, onRobinhood: false, walletName: null, error: null, switchToRobinhood: async () => false, disconnect: ${noop} }`;
  // A returning visitor: Harbour in light, stored and cached the way Landing.tsx leaves it after a visit.
  const harbour = PALETTES[2]!;
  const stored = JSON.stringify({ choice: "r2", theme: "light", custom: [] });
  const cache = JSON.stringify({ key: stored, mode: "light", inner: innerVars(harbour, false), landing: themeVars(harbour, false) });
  const seed = `localStorage.setItem("othello.theme", ${JSON.stringify(stored)}); localStorage.setItem("othello.theme.vars", ${JSON.stringify(cache)});`;
  const baseVars = cssVars(themeVars(PALETTES[0]!, false));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><script>${seed}</script>` +
    `<style>:root{${baseVars}}${screenDefaults}</style><script>${paintStoredTheme}</script></head>` +
    `<body><div id="root"></div><script>globalThis.__a6t = { ui: ${ui}, evm: ${evm} };</script><script src="page.js"></script></body></html>`;
}

const leftovers: string[] = [];
after(async () => {
  for (const dir of leftovers) rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
});

function run(html: string, js: string): Record<string, string | null> {
  const errors: string[] = [];
  for (const { bin, windows } of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a6-tab-"));
    try {
      const file = join(dir, "page.html");
      writeFileSync(file, html);
      writeFileSync(join(dir, "page.js"), js);
      const url = windows ? "file:" + forBrowser(file, true).replace(/\\/g, "/") : pathToFileURL(file).href;
      const r = spawnSync(bin, [windows ? "--headless=new" : "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${forBrowser(join(dir, "profile"), windows)}`, "--virtual-time-budget=5000", "--dump-dom", url],
        { encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
      const m = (r.stdout ?? "").match(/<pre id="a6-out">([\s\S]*?)<\/pre>/);
      if (m) return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      errors.push(`${bin} (status ${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
    } finally {
      // a Windows Chrome can still be writing its profile when spawnSync returns: retried in after()
      try { rmSync(dir, { recursive: true, force: true }); } catch { leftovers.push(dir); }
    }
  }
  throw new Error(`no Chromium ran; set CHROME to a chrome or chrome-headless-shell binary.\n${errors.join("\n")}`);
}

describe("a6 theme wallet modal after another tab's change, adversary", () => {
  it("the modal opened on Landing after another tab picked a palette opens in that palette, not the one before", async () => {
    const out = run(page(), await bundle());
    assert.equal(out["error"], undefined, `the page threw: ${out["error"]}`);
    assert.equal(out["storedAtEnd"], JSON.stringify({ choice: "r3", theme: "dark", custom: [] }), "precondition: the other tab's choice is the stored one");
    const harbourLight = innerVars(PALETTES[2]!, false)["--panel"]!.toLowerCase();
    const newsprintDark = innerVars(PALETTES[3]!, true)["--panel"]!.toLowerCase();
    assert.equal(out["landingBefore"], themeVars(PALETTES[2]!, false)["--desk"]!.toLowerCase(), "precondition: Landing opened in the visitor's Harbour light");
    assert.equal(out["modalSettled"], newsprintDark, "precondition: once its useTheme has read storage, the modal is the other tab's Newsprint dark");
    assert.notEqual(harbourLight, newsprintDark, "precondition: the two palettes differ");
    assert.equal(out["modalFirst"], out["modalSettled"],
      `the modal's first frame is ${out["modalFirst"] === harbourLight ? "Harbour light, the palette before the other tab's change" : out["modalFirst"]}, then it switches`);
  });
});
