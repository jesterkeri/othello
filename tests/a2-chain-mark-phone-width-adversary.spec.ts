/**
 * Adversary, A2 chain logos (Joshua, 2026-10-03), pass on bc6abad. The spec: "layout must not break at phone width (the
 * landing top bar is a 3-column grid)", and the active chain's mark is "visible ... on every page". To change chain the
 * person opens the wallet menu ("Use another network"), so the wallet pill must stay on screen.
 *
 * The real app/src/app/page.tsx (the landing page, /) is rendered with react-dom/server (the app's own React) over
 * stubbed wallet contexts with only an EVM wallet connected, so its top bar holds the colours button, Robinhood Chain's
 * mark and the real address pill (components/othello/WalletConnect.tsx, unstubbed). The real CSS (globals.css and the
 * Landing, ChainMark and WalletConnect modules, each module's classes kept apart by a per-module prefix, as CSS modules
 * do) is applied, and a real Chromium lays the page out inside a 360px iframe (the phone width the Shell's CSS is
 * built for, and many Android phones'; the iframe is its own viewport, so the page's media queries see a phone). Browser: $CHROME, else Playwright's cached
 * chrome-headless-shell, else Windows Chrome under WSL. No network: the document is a local file.
 *
 * Control: the same markup with the chain mark removed lays out inside the frame, so any overflow is the mark's.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-chain-mark-phone-width-adversary.spec.ts
 *
 * Installs module loader hooks: run in its own mocha process.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const PAGE = resolve(SRC, "app/page.tsx");
const CSS_FILES = {
  Landing: resolve(SRC, "components/landing/Landing.module.css"),
  ChainMark: resolve(SRC, "components/othello/ChainMark.module.css"),
  WalletConnect: resolve(SRC, "components/othello/WalletConnect.module.css"),
};
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Ctx = { ui: Record<string, unknown>; evm: Record<string, unknown>; path: string };
const g = globalThis as { __a2p?: Ctx; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? "";
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) {
      // each module's class names get its own prefix, as CSS modules hash them apart (Landing and WalletConnect share names)
      const mod = basename(specifier, ".module.css");
      return stub(`export default new Proxy({}, { get: (_, k) => typeof k === "string" ? ${JSON.stringify(mod)} + "_" + k : undefined });`);
    }
    if (parent.endsWith("/components/othello/Shell.tsx") && specifier === "./StockSearch") {
      return stub("export default function StockSearch() { return null; }");
    }
    if (specifier === "next/navigation") return stub("export const usePathname = () => globalThis.__a2p.path;");
    if (specifier === "@/lib/wallet") {
      // the real shortAddress (lib/wallet.tsx), restated: the stub replaces only the React context
      return stub("export const useWalletUi = () => globalThis.__a2p.ui; export const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;");
    }
    if (specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => globalThis.__a2p.evm;");
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

async function render(ctx: Ctx): Promise<string> {
  const React = appRequire("react");
  g.React = React;
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const mod = await import(pathToFileURL(PAGE).href);
  g.__a2p = ctx;
  return renderToStaticMarkup(React.createElement(mod.default, {}));
}

/** A module's stylesheet with every class selector given the module's prefix (values such as `.5` are not classes). */
function scoped(mod: string, css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\.([a-zA-Z_][\w-]*)/g, `.${mod}_$1`);
}

/** Browsers to lay the page out with: $CHROME, Playwright's cached chrome-headless-shell, then Windows Chrome under WSL. */
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

function fileUrl(path: string, windows: boolean): string {
  return windows ? "file:" + forBrowser(path, true).replace(/\\/g, "/") : pathToFileURL(path).href;
}

type Box = { left: number; right: number; width: number; display: string } | null;
type Layout = { inner: number; scroll: number; frameRight: number; pill: Box; mark: Box; markInBar: boolean; nav: Box };

/** Lays the markup out in Chromium inside a `width` CSS px iframe and returns where the top bar's parts land. */
function layout(markup: string, width: number): Layout {
  // next/font's variables (app/src/app/layout.tsx) name web fonts that are not here offline; the stylesheets' own
  // fallbacks (Helvetica, Arial, sans-serif) are used instead
  const css = ":root { --font-jakarta: 'Plus Jakarta Sans'; --font-archivo: Archivo; }\n" +
    readFileSync(resolve(SRC, "app/globals.css"), "utf8") + "\n" +
    Object.entries(CSS_FILES).map(([m, f]) => scoped(m, readFileSync(f, "utf8"))).join("\n");
  const probe = `
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, display: getComputedStyle(el).display }; };
    const header = document.querySelector('header.Landing_nav');
    const frame = document.querySelector('.Landing_frame').getBoundingClientRect();
    const out = { inner: window.innerWidth, scroll: document.documentElement.scrollWidth, frameRight: frame.right,
      pill: box(header.querySelector('.WalletConnect_pill')), mark: box(header.querySelector('.ChainMark_chainMark')),
      markInBar: !!header.querySelector('.ChainMark_chainMark'), nav: box(header.querySelector('nav.Landing_pillGroup')) };
    const pre = parent.document.createElement('pre'); pre.id = 'layout-out'; pre.textContent = JSON.stringify(out); parent.document.body.appendChild(pre);`;
  const inner = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
    `<body>${markup}<script>${probe}</script></body></html>`;
  const outer = `<!doctype html><html><body style="margin:0"><iframe width="${width}" height="844" style="border:0;display:block" ` +
    `srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></body></html>`;
  const errors: string[] = [];
  for (const b of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a2-phone-"));
    try {
      const file = join(dir, "landing.html");
      writeFileSync(file, outer);
      const r = spawnSync(b.bin, [
        b.windows ? "--headless=new" : "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
        "--disable-extensions", `--user-data-dir=${forBrowser(join(dir, "profile"), b.windows)}`,
        "--window-size=800,900", "--virtual-time-budget=3000", "--dump-dom", fileUrl(file, b.windows),
      ], { encoding: "utf8", timeout: 90_000 });
      const json = /<pre id="layout-out">([^<]*)<\/pre>/.exec(r.stdout ?? "")?.[1];
      if (json) return JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Layout;
      errors.push(`${b.bin} (status ${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`no Chromium laid the page out; set CHROME to a chrome or chrome-headless-shell binary.\n${errors.join("\n")}`);
}

const noop = () => {};
const ui = { address: null, walletName: null, stage: "closed", openConnect: noop, disconnect: noop };
const evm = { address: "0x1111111111111111111111111111111111111111", onRobinhood: true, walletName: "MetaMask", disconnect: noop };
// the repo's own phone target: "The five-item pill fits a 360px screen" (components/othello/Shell.module.css)
const PHONE = 360;

describe("A2 adversary (bc6abad): the landing top bar with the chain mark at phone width", () => {
  let markup = "";
  before(async () => {
    markup = await render({ path: "/", ui, evm });
    assert.ok(markup.includes("Showing Robinhood Chain testnet"), "precondition: only MetaMask, so the active side is Robinhood Chain");
  });

  it("control: the same top bar without the chain mark keeps the wallet pill inside the frame on a 360px screen", () => {
    const withoutMark = markup.replace(/<span class="ChainMark_chainMark"[\s\S]*?<\/svg><\/span>/, "");
    assert.notEqual(withoutMark, markup, "precondition: the mark was found and removed");
    const l = layout(withoutMark, PHONE);
    assert.equal(l.inner, PHONE, "precondition: the viewport is the phone's width");
    assert.ok(l.pill, "precondition: the real address pill renders in the top bar");
    assert.ok(l.pill.right <= l.frameRight, `control: the pill ends at ${l.pill.right}px, inside the frame (${l.frameRight}px)`);
  });

  it("only MetaMask on /, 360px wide: the chain mark and the wallet pill both stay on screen, inside the frame", () => {
    const l = layout(markup, PHONE);
    assert.equal(l.inner, PHONE, "precondition: the viewport is the phone's width");
    assert.ok(l.markInBar && l.mark && l.mark.display !== "none", "the active chain's mark is shown in the top bar");
    assert.ok(l.pill, "precondition: the real address pill renders in the top bar");
    assert.ok(
      l.pill.right <= l.frameRight && l.mark.right <= l.frameRight,
      `at ${PHONE}px the landing top bar overflows: the wallet pill (the way to "Use another network" and Disconnect) ` +
        `ends at ${l.pill.right.toFixed(1)}px, past the frame's edge at ${l.frameRight.toFixed(1)}px on a ${l.inner}px ` +
        `screen, which clips everything past ${l.inner}px (Landing .root overflow-x: clip)`,
    );
  });
});
