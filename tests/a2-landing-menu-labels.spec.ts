/**
 * A2 chain logos, fix pass on 238d644 (an adversary pass found landing menu labels cut to "…" at 360-600px and
 * 760-900px, and the chain mark newly cutting "Circles" at 760px). The harness is tests/a2-landing-topbar-widths-
 * adversary.spec.ts's (the real app/src/app/page.tsx and its real CSS in real Chromium with Plus Jakarta Sans fetched
 * from Google Fonts, as next/font loads it); the probe also records each menu label whose text overflows its box.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-landing-menu-labels.spec.ts   (needs network for the font)
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

type Box = { left: number; right: number; width: number };
type Layout = { width: number; inner: number; frameRight: number; jakarta: string; parts: Record<string, Box | null> };

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@200..800&display=swap";
// Google Fonts serves woff2 only to a browser it recognises
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Plus Jakarta Sans, latin subset, as Google Fonts serves it (the file next/font/google self-hosts). */
async function jakartaLatin(): Promise<{ url: string; bytes: Buffer }> {
  const css = await (await fetch(FONT_CSS, { headers: { "user-agent": UA } })).text();
  const block = css.split("@font-face").find((b) => b.includes("U+0000-00FF"));
  const url = block && /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
  assert.ok(url, `no latin Plus Jakarta Sans woff2 in ${FONT_CSS}`);
  const res = await fetch(url);
  assert.ok(res.ok, `font download failed: ${res.status} ${url}`);
  return { url, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Lays the markup out in Chromium, one iframe per width, with or without the site's own font. */
function layouts(markup: string, widths: number[], font: Buffer | null): Layout[] {
  const face = font ? "@font-face { font-family: 'Plus Jakarta Sans'; font-weight: 200 800; src: url(jakarta.woff2) format('woff2'); }\n" : "";
  const css = face + ":root { --font-jakarta: 'Plus Jakarta Sans'; --font-archivo: Archivo; }\n" +
    readFileSync(resolve(SRC, "app/globals.css"), "utf8") + "\n" +
    Object.entries(CSS_FILES).map(([m, f]) => scoped(m, readFileSync(f, "utf8"))).join("\n");
  const probe = (w: number) => `
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const header = document.querySelector('header.Landing_nav');
    const q = (sel) => box(header.querySelector(sel));
    const parts = { logo: q('.Landing_logo'), colours: q('.Landing_iconBtn'), mark: q('.ChainMark_chainMark'),
      walletPill: q('.WalletConnect_pill'), connect: q('.Landing_connect, .WalletConnect_connect') };
    [...header.querySelectorAll('nav.Landing_pillGroup a')].forEach((a) => { parts['menu ' + a.textContent] = box(a); if (a.scrollWidth > a.clientWidth) (window.__cut = window.__cut || []).push(a.textContent + ' ' + a.clientWidth + '<' + a.scrollWidth); });
    const jakarta = [...document.fonts].filter((f) => f.family.includes('Jakarta')).map((f) => f.status).join(',') || 'not declared';
    const out = { cut: window.__cut || [], width: ${w}, inner: window.innerWidth, frameRight: document.querySelector('.Landing_frame').getBoundingClientRect().right, jakarta, parts };
    const pre = parent.document.createElement('pre'); pre.className = 'layout-out'; pre.textContent = JSON.stringify(out); parent.document.body.appendChild(pre);`;
  const frames = widths.map((w) => {
    const inner = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body>${markup}<script>document.fonts.ready.then(() => { ${probe(w)} });</script></body></html>`;
    return `<iframe width="${w}" height="400" style="border:0;display:block" srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
  });
  const outer = `<!doctype html><html><body style="margin:0">${frames.join("")}</body></html>`;
  const errors: string[] = [];
  for (const b of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a2-widths-"));
    try {
      const file = join(dir, "landing.html");
      writeFileSync(file, outer);
      if (font) writeFileSync(join(dir, "jakarta.woff2"), font);
      const r = spawnSync(b.bin, [
        b.windows ? "--headless=new" : "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
        "--disable-extensions", "--allow-file-access-from-files", `--user-data-dir=${forBrowser(join(dir, "profile"), b.windows)}`,
        "--window-size=1600,900", "--virtual-time-budget=5000", "--dump-dom", fileUrl(file, b.windows),
      ], { encoding: "utf8", timeout: 120_000 });
      const found = [...(r.stdout ?? "").matchAll(/<pre class="layout-out">([^<]*)<\/pre>/g)]
        .map((m) => JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Layout);
      if (found.length === widths.length) return widths.map((w) => found.find((l) => l.width === w)!);
      errors.push(`${b.bin} (status ${r.status}, ${found.length} of ${widths.length}): ${(r.stderr ?? "").slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`no Chromium laid the page out; set CHROME to a chrome or chrome-headless-shell binary.\n${errors.join("\n")}`);
}

/** Every top-bar part that ends past the landing frame's right edge, as "part ends at Xpx". */
function pastFrame(l: Layout): string[] {
  return Object.entries(l.parts)
    .filter(([, b]) => b && b.right > l.frameRight + 0.5)
    .map(([k, b]) => `${k} ends at ${b!.right.toFixed(1)}px`);
}

const noop = () => {};
const noUi = { address: null, walletName: null, stage: "closed", openConnect: noop, disconnect: noop };
const noEvm = { address: null, onRobinhood: false, walletName: null, disconnect: noop, switchToRobinhood: noop };
// the same EVM wallet as tests/a2-chain-mark-phone-width-adversary.spec.ts; its pill shows 0x1111…1111 in tabular
// figures, so every EVM address makes a pill this wide
const EVM = { address: "0x1111111111111111111111111111111111111111", onRobinhood: true, walletName: "MetaMask", disconnect: noop, switchToRobinhood: noop };
// Solana's System Program id, a real base58 account key (the pill shows its first and last four characters)
const SOL = { ...noUi, address: "11111111111111111111111111111111", walletName: "Phantom" };
const STATES: [string, Ctx][] = [
  ["no wallet", { path: "/", ui: noUi, evm: noEvm }],
  ["EVM wallet only", { path: "/", ui: noUi, evm: EVM }],
  ["Solana wallet only", { path: "/", ui: SOL, evm: noEvm }],
  ["both wallets", { path: "/", ui: SOL, evm: EVM }],
];
// the repo's phone target (360px, components/othello/Shell.module.css) up to 375px (iPhone SE and mini)
const WIDTHS = [360, 362, 364, 366, 368, 370, 372, 374, 375];

// Kept from a fix pass on 238d644 (adversary pass: menu labels cut to "…" at 360-600px and 760-900px, worse at 760px
// with the chain mark). Every label of the landing menu shows its whole text at every width, in each wallet state.
const SOL_UI = { ...noUi, address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", walletName: "Phantom" };
const MENU_WIDTHS = [360, 375, 414, 500, 600, 700, 759, 760, 800, 900, 1023, 1024, 1280];
describe("A2 landing menu: no label cut to an ellipsis, 360px to desktop, with the site's font", () => {
  for (const [name, ui, evm] of [["no wallet", noUi, noEvm], ["EVM wallet", noUi, EVM], ["Solana wallet", SOL_UI, noEvm], ["EVM on another network", noUi, { ...EVM, onRobinhood: false }]] as const) {
    it(`${name}: every menu label shows its whole text at ${MENU_WIDTHS.join(", ")}px`, async () => {
      const font = await jakartaLatin();
      const m = await render({ path: "/", ui, evm });
      const cut: string[] = [];
      for (const l of layouts(m, MENU_WIDTHS, font.bytes) as (Layout & { cut: string[] })[]) {
        assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
        assert.ok(Object.keys(l.parts).filter((k) => k.startsWith("menu ")).length === 5, "precondition: the five menu labels are measured");
        for (const c of l.cut) cut.push(`${l.width}px: ${c.replace("&lt;", " wide, its text ")}`);
      }
      assert.deepEqual(cut, [], `${name}: menu labels cut to an ellipsis`);
    });
  }
});
