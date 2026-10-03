/**
 * Adversary, A2 chain logos (Joshua, 2026-10-03), pass on 8df6d80. The spec: on the landing page the top bar (logo, menu
 * pills, the colours button, the chain mark, the wallet pill or Connect wallet) "must stay on screen and usable, in every
 * wallet state (none, EVM, Solana, both), at 360px and wider"; "layout must not break at phone width". 8df6d80 moved the
 * menu pills to their own row under 760px so the top row fits a 360px screen, and
 * tests/a2-chain-mark-phone-width-adversary.spec.ts checks that the wallet pill ends inside the landing frame. That spec
 * lays the page out without the site's font: --font-jakarta names 'Plus Jakarta Sans', which is not installed, so
 * Chromium falls back to Helvetica or Arial. The site itself serves Plus Jakarta Sans (app/src/app/layout.tsx,
 * next/font/google, weights 400 to 800), and the pill's address is set in it at weight 800, wider than the fallback.
 *
 * Here the same harness (the real app/src/app/page.tsx rendered with the app's React over stubbed wallet contexts, the
 * real globals.css and the Landing, ChainMark and WalletConnect modules, a real Chromium, an iframe as the phone's
 * viewport) lays the page out twice: once with the fallback font (the control, as the existing spec does), and once with
 * Plus Jakarta Sans loaded from Google Fonts, the source next/font/google downloads it from at build time (css2 API,
 * latin subset, the variable 200..800 file; fetched read-only at test time, the URL is printed).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-landing-topbar-widths-adversary.spec.ts
 *
 * Needs the network for the font (fails with a clear error without it). Installs module loader hooks: run in its own
 * mocha process.
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
    [...header.querySelectorAll('nav.Landing_pillGroup a')].forEach((a) => { parts['menu ' + a.textContent] = box(a); });
    const jakarta = [...document.fonts].filter((f) => f.family.includes('Jakarta')).map((f) => f.status).join(',') || 'not declared';
    const out = { width: ${w}, inner: window.innerWidth, frameRight: document.querySelector('.Landing_frame').getBoundingClientRect().right, jakarta, parts };
    const pre = parent.document.createElement('pre'); pre.className = 'layout-out'; pre.textContent = JSON.stringify(out); parent.document.body.appendChild(pre);`;
  const frames = widths.map((w) => {
    const inner = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
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

describe("A2 adversary (8df6d80): the landing top bar at 360px with the site's own font", () => {
  let font: { url: string; bytes: Buffer };
  const markups: Record<string, string> = {};
  before(async () => {
    font = await jakartaLatin();
    console.log(`      font: ${font.url} (${font.bytes.length} bytes)`);
    for (const [name, ctx] of STATES) markups[name] = await render(ctx);
  });

  it("control: with the fallback font (as tests/a2-chain-mark-phone-width-adversary.spec.ts lays it out) every part fits", () => {
    for (const [name] of STATES) {
      for (const l of layouts(markups[name]!, WIDTHS, null)) {
        assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
        assert.deepEqual(pastFrame(l), [], `control, ${name}, ${l.width}px: every part inside the frame (${l.frameRight}px)`);
      }
    }
  });

  for (const [name] of STATES) {
    it(`${name}, 360 to 375px, Plus Jakarta Sans loaded: every top-bar part ends inside the landing frame`, () => {
      const bad: string[] = [];
      for (const l of layouts(markups[name]!, WIDTHS, font.bytes)) {
        assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
        assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
        assert.ok(name === "no wallet" || l.parts.mark, `precondition, ${name}: the chain mark is in the top bar`);
        const past = pastFrame(l);
        if (past.length) bad.push(`${l.width}px screen, frame edge at ${l.frameRight.toFixed(1)}px: ${past.join(", ")}`);
      }
      assert.deepEqual(bad, [], `${name}: with the site's font the landing top bar runs past the frame`);
    });
  }
});

// Spec rule 2: "the wallet menu (the address pill's menu) has 'Use another network'; the pill must always be reachable".
// An EVM wallet that is connected but on another chain (MetaMask left on Ethereum, say) still counts as connected
// (lib/active-side.ts useConnected: robinhood = !!evm.address), so / shows Robinhood Chain's mark.
describe("A2 adversary (8df6d80): the address pill with an EVM wallet on another chain", () => {
  it("only MetaMask, on another chain, on /: the top bar still has the address pill (its menu holds Use another network)", async () => {
    const markup = await render({ path: "/", ui: noUi, evm: { ...EVM, onRobinhood: false } });
    const header = /<header class="Landing_nav"[\s\S]*?<\/header>/.exec(markup)?.[0] ?? "";
    assert.ok(header.includes('class="ChainMark_chainMark" data-mode="light" role="img" aria-label="Robinhood Chain testnet"'),
      "precondition: Robinhood Chain's mark is shown, so the page counts the wallet as connected");
    assert.ok(header.includes("Switch network"), "precondition: the wallet is on another chain");
    assert.ok(
      header.includes('class="WalletConnect_pill"'),
      "with the EVM wallet on another chain the top bar holds only a Switch network button: no address pill, so neither " +
        "Use another network nor Disconnect can be reached",
    );
  });
});
