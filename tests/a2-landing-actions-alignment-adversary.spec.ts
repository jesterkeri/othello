/**
 * Adversary, A2 chain logos (Joshua, 2026-10-03), pass on cf8e9b5. The spec, rule 3: "Layout must not break at any width
 * from 360px through desktop (including 759/760/761 and 1023/1024/1025px), in every wallet state ..., on every page
 * (landing, ...): ... the landing page's first screen still showing its main content and its primary action without
 * awkward gaps."
 *
 * The landing top bar is a grid, `auto minmax(0, 1fr) auto`: the logo, the menu pills, then the actions (the colours
 * button, the chain mark, the wallet pill or Connect wallet) in the last column, against the bar's right edge. cf8e9b5
 * (Landing.module.css, `@media (max-width: 1023px) { .pillGroup { grid-column: 1 / -1; grid-row: 2; } }`, widening
 * 8df6d80's phone-only rule) gives the menu its own row but leaves the actions auto-placed: with the menu out of row one
 * they fall into the middle `1fr` column, packed to its start. So below 1024px the colours button, the mark and the
 * wallet pill sit against the logo, with the rest of the row empty (about 700px of it at 1023px with no wallet), and at
 * 1024px the whole group jumps to the right edge. On de78a6f, before the feature, the actions end at the bar's right
 * edge at every width, as they still do here from 1024px.
 *
 * Harness: tests/a2-landing-menu-labels.spec.ts's (the real app/src/app/page.tsx over stubbed wallet contexts, the real
 * globals.css and the Landing, ChainMark and WalletConnect modules, a real Chromium, one iframe per width as its
 * viewport, Plus Jakarta Sans fetched read-only from Google Fonts). The probe records where the top row's last control
 * ends against the bar's content edge (its right edge less its padding and border).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-landing-actions-alignment-adversary.spec.ts
 *
 * Needs the network for the font. Installs module loader hooks: run in its own mocha process.
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
type Layout = {
  width: number; inner: number; jakarta: string; contentRight: number; actions: Box; last: Box & { what: string }; menuTop: number; barTop: number;
};

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
    Object.entries(CSS_FILES).filter(([, f]) => existsSync(f)).map(([m, f]) => scoped(m, readFileSync(f, "utf8"))).join("\n");
  const probe = (w: number) => `
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const header = document.querySelector('header.Landing_nav');
    const hb = header.getBoundingClientRect();
    const actions = header.querySelector('.Landing_navActions');
    // the top row's last control: the wallet pill, the wallet's own Connect button, or the landing page's Connect wallet
    const lastEl = [...actions.querySelectorAll('.WalletConnect_pill, .WalletConnect_connect, .Landing_connect')].pop();
    const jakarta = [...document.fonts].filter((f) => f.family.includes('Jakarta')).map((f) => f.status).join(',') || 'not declared';
    const out = { width: ${w}, inner: window.innerWidth, jakarta,
      contentRight: hb.right - parseFloat(getComputedStyle(header).paddingRight) - parseFloat(getComputedStyle(header).borderRightWidth),
      actions: box(actions), last: { ...box(lastEl), what: lastEl.textContent }, menuTop: header.querySelector('nav.Landing_pillGroup').getBoundingClientRect().top,
      barTop: header.querySelector('.Landing_logo').getBoundingClientRect().top };
    const pre = parent.document.createElement('pre'); pre.className = 'layout-out'; pre.textContent = JSON.stringify(out); parent.document.body.appendChild(pre);`;
  const frames = widths.map((w) => {
    const inner = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body>${markup}<script>document.fonts.ready.then(() => { ${probe(w)} });</script></body></html>`;
    return `<iframe width="${w}" height="500" style="border:0;display:block" srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
  });
  const outer = `<!doctype html><html><body style="margin:0">${frames.join("")}</body></html>`;
  const errors: string[] = [];
  for (const b of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a2-landing-actions-"));
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

const noop = () => {};
const noUi = { address: null, walletName: null, stage: "closed", openConnect: noop, disconnect: noop };
const noEvm = { address: null, onRobinhood: false, walletName: null, disconnect: noop, switchToRobinhood: noop };
// the same wallets as tests/a2-landing-menu-labels.spec.ts
const EVM = { address: "0x1111111111111111111111111111111111111111", onRobinhood: true, walletName: "MetaMask", disconnect: noop, switchToRobinhood: noop };
const SOL = { ...noUi, address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", walletName: "Phantom" };
const STATES: [string, Ctx][] = [
  ["no wallet", { path: "/", ui: noUi, evm: noEvm }],
  ["EVM wallet on Robinhood Chain", { path: "/", ui: noUi, evm: EVM }],
  ["EVM wallet on another network", { path: "/", ui: noUi, evm: { ...EVM, onRobinhood: false } }],
  ["Solana wallet", { path: "/", ui: SOL, evm: noEvm }],
  ["both wallets", { path: "/", ui: SOL, evm: EVM }],
];
const DESKTOP = [1024, 1025, 1280];
const BELOW = [360, 414, 600, 759, 760, 761, 900, 1023];

/** How far the top row's last control stops short of the bar's content edge, or null when it reaches it. */
function shortOfEdge(l: Layout): string | null {
  const gap = l.contentRight - l.last.right;
  if (gap <= 2) return null;
  return `${l.width}px: "${l.last.what}" ends at ${l.last.right.toFixed(1)}px, ${gap.toFixed(1)}px short of the bar's edge ` +
    `(${l.contentRight.toFixed(1)}px); the actions start at ${l.actions.left.toFixed(1)}px`;
}

describe("A2 adversary (cf8e9b5): the landing top bar's actions keep to its right edge below 1024px", () => {
  let font: { url: string; bytes: Buffer };
  const markups: Record<string, string> = {};
  before(async () => {
    font = await jakartaLatin();
    console.log(`      font: ${font.url} (${font.bytes.length} bytes)`);
    for (const [name, ctx] of STATES) markups[name] = await render(ctx);
  });

  it(`control: at ${DESKTOP.join(", ")}px the wallet control ends at the bar's right edge in every wallet state`, () => {
    for (const [name] of STATES) {
      for (const l of layouts(markups[name]!, DESKTOP, font.bytes)) {
        assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
        assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
        assert.equal(shortOfEdge(l), null, `control, ${name}`);
      }
    }
  });

  for (const [name] of STATES) {
    it(`${name}, ${BELOW.join(", ")}px: the wallet control ends at the bar's right edge, not beside the logo`, () => {
      const bad: string[] = [];
      for (const l of layouts(markups[name]!, BELOW, font.bytes)) {
        assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
        assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
        const s = shortOfEdge(l);
        if (s) bad.push(s);
      }
      assert.deepEqual(bad, [], `${name}: the landing top bar's actions are packed against the logo, the row's right side empty`);
    });
  }
});
