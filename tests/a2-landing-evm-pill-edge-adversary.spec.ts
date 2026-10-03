/**
 * Adversary, A2 chain logos (Joshua, 2026-10-03), pass on 9f9fd26. The spec, rule 3: "Layout must not break at any
 * width from 360px through desktop ..., in every wallet state, on every page, with the site's real font: nothing
 * squeezed, nothing overflowing, ..., the landing top bar's actions at its right edge"; rule 2: "on a wrong EVM network
 * the pill says so and offers the switch".
 *
 * 9f9fd26 (Landing.module.css, under 1024px: `.navActions { grid-column: 3; grid-row: 1; justify-self: end; }`) puts
 * the actions in the bar's last grid column, `auto`, sized by its content. Before it (cf8e9b5) they sat in the
 * `minmax(0, 1fr)` middle column, which could shrink. At 360px the top row (logo, colours button, the feature's chain
 * mark, the wallet pill) is now wider than the bar for an EVM wallet: the grid's tracks overrun its content box, so the
 * pill runs into the bar's right padding, and with "Switch network" (an EVM wallet on another network) onto the
 * frame's 5px border, with the menu row under it pushed out too.
 *
 * tests/a2-landing-actions-alignment-adversary.spec.ts measures the same edge (the header's right edge less its padding
 * and border) but fails only when the last control stops short of it, never when it runs past; tests/a2-landing-
 * topbar-widths-adversary.spec.ts checks only the frame's outer edge, 17px further right.
 *
 * Fixtures: the EOA that deployed the factory on Robinhood Chain testnet (chain 46630), read from
 * evm/broadcast/DeployFactory.s.sol/46630/run-latest.json in before(), checksummed with the app's viem as the EVM
 * session holds it. Controls: no wallet, and a Solana wallet (the System Program id, as the earlier specs use).
 * Run against cf8e9b5 the deployer case passes and the wrong-network pill ends 4.9px past the edge (the menu inside);
 * against de78a6f the deployer case passes (the wrong-network pill did not exist yet).
 *
 * Same harness as tests/a2-landing-topbar-widths-adversary.spec.ts (the real app/src/app/page.tsx over stubbed wallet
 * contexts, the real globals.css and the Landing, ChainMark and WalletConnect modules, a real Chromium, one iframe per
 * width as the viewport, Plus Jakarta Sans fetched read-only from Google Fonts), with the charset declared.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-landing-evm-pill-edge-adversary.spec.ts
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
  width: number; inner: number; frameRight: number; contentRight: number; shortText: string | null; jakarta: string; parts: Record<string, Box | null>;
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
    // ChainMark.module.css is new in this feature: missing when this spec is run on de78a6f, the commit before it
    Object.entries(CSS_FILES).filter(([, f]) => existsSync(f)).map(([m, f]) => scoped(m, readFileSync(f, "utf8"))).join("\n");
  const probe = (w: number) => `
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const header = document.querySelector('header.Landing_nav');
    const q = (sel) => box(header.querySelector(sel));
    const parts = { logo: q('.Landing_logo'), colours: q('.Landing_iconBtn'), mark: q('.ChainMark_chainMark'),
      walletPill: q('.WalletConnect_pill'), connect: q('.Landing_connect, .WalletConnect_connect') };
    [...header.querySelectorAll('nav.Landing_pillGroup a')].forEach((a) => { parts['menu ' + a.textContent] = box(a); });
    const jakarta = [...document.fonts].filter((f) => f.family.includes('Jakarta')).map((f) => f.status).join(',') || 'not declared';
    const hs = getComputedStyle(header);
    const short = header.querySelector('.WalletConnect_short');
    const out = { width: ${w}, inner: window.innerWidth, frameRight: document.querySelector('.Landing_frame').getBoundingClientRect().right,
      contentRight: header.getBoundingClientRect().right - parseFloat(hs.paddingRight) - parseFloat(hs.borderRightWidth),
      shortText: short ? short.textContent : null, shortVisible: short ? short.innerText : null, jakarta, parts };
    const pre = parent.document.createElement('pre'); pre.className = 'layout-out'; pre.textContent = JSON.stringify(out); parent.document.body.appendChild(pre);`;
  const frames = widths.map((w) => {
    // the charset is declared: without it Chromium sometimes reads the srcdoc as windows-1252 and the pill's "…" turns
    // into three characters, about 13px wider (seen while writing this spec)
    const inner = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body>${markup}<script>document.fonts.ready.then(() => { ${probe(w)} });</script></body></html>`;
    return `<iframe width="${w}" height="400" style="border:0;display:block" srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
  });
  const outer = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${frames.join("")}</body></html>`;
  const errors: string[] = [];
  for (const b of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a2-evm-pill-edge-"));
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

/** Every top-bar part that ends past the bar's content edge (its right edge less its padding and border), as "part ends at Xpx". */
function pastEdge(l: Layout): string[] {
  return Object.entries(l.parts)
    .filter(([, b]) => b && b.right > l.contentRight + 0.5)
    .map(([k, b]) => `${k} ends at ${b!.right.toFixed(1)}px${b!.right > l.frameRight + 0.5 ? " (past the frame)" : ""}`);
}

const noop = () => {};
const noUi = { address: null, walletName: null, stage: "closed", openConnect: noop, disconnect: noop };
const noEvm = { address: null, onRobinhood: false, walletName: null, disconnect: noop, switchToRobinhood: noop };
// The EOA that deployed the factory on Robinhood Chain testnet (chain 46630): the "from" of
// evm/broadcast/DeployFactory.s.sol/46630/run-latest.json, lower case there; the EVM session holds it checksummed
// (lib/robinhood/evm-session.ts firstAccount: viem getAddress), so the pill reads "0xDCA9…a1Ff".
const DEPLOYER = "0xDCA915e9F833002c978e162610E3e88eD159a1Ff";
const EVM = { address: DEPLOYER, onRobinhood: true, walletName: "MetaMask", disconnect: noop, switchToRobinhood: noop };
// Solana's System Program id, as tests/a2-landing-topbar-widths-adversary.spec.ts uses it
const SOL = { ...noUi, address: "11111111111111111111111111111111", walletName: "Phantom" };
const CONTROLS: [string, Ctx][] = [
  ["no wallet", { path: "/", ui: noUi, evm: noEvm }],
  ["Solana wallet", { path: "/", ui: SOL, evm: noEvm }],
];
const WIDTHS = [360, 362, 364, 366, 368, 370, 372, 374, 375];

describe("A2 adversary (9f9fd26): the landing top bar at 360px with a real EVM wallet", () => {
  let font: { url: string; bytes: Buffer };
  before(async () => {
    const broadcast = JSON.parse(readFileSync(resolve(REPO, "evm/broadcast/DeployFactory.s.sol/46630/run-latest.json"), "utf8"));
    assert.equal(broadcast.transactions[0].transaction.from, DEPLOYER.toLowerCase(), "precondition: the fixture is the factory deployer");
    const { getAddress } = appRequire("viem");
    assert.equal(getAddress(DEPLOYER.toLowerCase()), DEPLOYER, "precondition: the address as the EVM session holds it (checksummed)");
    font = await jakartaLatin();
    console.log(`      font: ${font.url} (${font.bytes.length} bytes)`);
  });

  for (const [name, ctx] of CONTROLS) {
    it(`control, ${name}: every top-bar part ends inside the bar at 360 to 375px`, async () => {
      for (const l of layouts(await render(ctx), WIDTHS, font.bytes)) {
        assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
        assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
        assert.deepEqual(pastEdge(l), [], `control, ${name}, ${l.width}px`);
      }
    });
  }

  it("EVM wallet (the factory deployer), 360 to 375px: the wallet pill ends inside the bar", async () => {
    const bad: string[] = [];
    for (const l of layouts(await render({ path: "/", ui: noUi, evm: EVM }), WIDTHS, font.bytes)) {
      assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
      assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
      assert.equal(l.shortText, "0xDCA9…a1Ff", "precondition: the pill shows the address, its ellipsis read as UTF-8");
      // the feature's chain mark (absent when this spec is run on de78a6f, the commit before the feature)
      if (readFileSync(resolve(SRC, "components/landing/Landing.tsx"), "utf8").includes("ChainMarkSlot")) assert.ok(l.parts.mark, "precondition: the chain mark is in the top bar");
      const past = pastEdge(l);
      if (past.length) bad.push(`${l.width}px: the bar's content edge at ${l.contentRight.toFixed(1)}px (frame ${l.frameRight.toFixed(1)}px): ${past.join(", ")}`);
    }
    assert.deepEqual(bad, [], "the landing top row is wider than the bar: the wallet pill runs past the bar's right edge into its padding");
  });

  // Spec rule 2: "on a wrong EVM network the pill says so and offers the switch". The pill then reads "Switch network"
  // (WalletConnect.tsx AddressPill), wider than any address, whatever the address.
  it("EVM wallet on another network, 360 to 375px: the Switch network pill ends inside the bar", async () => {
    const bad: string[] = [];
    for (const l of layouts(await render({ path: "/", ui: noUi, evm: { ...EVM, onRobinhood: false } }), WIDTHS, font.bytes)) {
      assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
      assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
      // fix pass: on phones the pill's visible label is the short "Switch" (its full "Switch network" is hidden there)
      assert.match(String((l as { shortVisible?: string | null }).shortVisible), /^Switch( network)?$/, "precondition: the pill says the wallet is on another network");
      const past = pastEdge(l);
      if (past.length) bad.push(`${l.width}px: the bar's content edge at ${l.contentRight.toFixed(1)}px (frame ${l.frameRight.toFixed(1)}px): ${past.join(", ")}`);
    }
    assert.deepEqual(bad, [], "the landing top row is wider than the bar: the pill runs past its right edge, the menu row with it");
  });
});
