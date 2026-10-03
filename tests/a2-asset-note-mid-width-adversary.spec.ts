/**
 * Adversary, A2 chain logos (Joshua, 2026-10-03), pass on 238d644. The spec, rule 3: "Layout must not break at phone
 * width (360px and up, through desktop, including the 759/760/761px boundaries), in every wallet state ..., on every
 * page: ... the asset pages (a "Mainnet, read only" chip with its note) ... Nothing squeezed into an unreadable column,
 * nothing overflowing the screen, the note readable."
 *
 * The asset pages keep their chip (components/assets/Shell.tsx passes chainSwitch={false} and a network chip), so
 * 238d644's row-two rule (Shell.module.css `.topbar:not(:has(.devnet)) .devnetText { flex-basis: 100% }`) does not
 * apply to them: under 760px the note keeps `flex: 1 1 0; min-width: 0` with order 4. From about 548px to 759px, with a
 * Solana wallet, row one holds the logo, the chain mark, the search icon, the colours button and the wallet pill, the
 * chip, and then the note, which gets whatever width is left (13px to 173px at 560 to 720px), its words overflowing it
 * below about 600px. tests/a2-app-topbar-note-width-adversary.spec.ts checks this note only at 360 to 414px, where row
 * one is full and the chip and note wrap to row two.
 *
 * Older defect: the same spec run on de78a6f (before the feature) fails too, at the same widths, with the note about
 * 16px wider there (no chain mark; a wider pill). The feature did not introduce it; it narrows the note further.
 *
 * Harness: as tests/a2-app-topbar-note-width-adversary.spec.ts (the real Shell and WalletConnect address pill over
 * stubbed wallet contexts, the real globals.css and module CSS, a real Chromium, one iframe per width as its viewport,
 * Plus Jakarta Sans fetched read-only from Google Fonts), with the real asset page frame (components/assets/Shell.tsx)
 * and the real StockSearch (its phone icon takes a place on row one).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-asset-note-mid-width-adversary.spec.ts
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
// the asset pages' own frame (/assets and /assets/<symbol>), which gives the Shell its chip and note
const ASSET_SHELL = resolve(SRC, "components/assets/Shell.tsx");
const CSS_FILES = {
  Shell: resolve(SRC, "components/othello/Shell.module.css"),
  ChainMark: resolve(SRC, "components/othello/ChainMark.module.css"),
  WalletConnect: resolve(SRC, "components/othello/WalletConnect.module.css"),
  StockSearch: resolve(SRC, "components/othello/StockSearch.module.css"),
};
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Ctx = { ui: Record<string, unknown>; evm: Record<string, unknown>; path: string };
const g = globalThis as { __a2s?: Ctx; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? "";
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) {
      const mod = basename(specifier, ".module.css");
      return stub(`export default new Proxy({}, { get: (_, k) => typeof k === "string" ? ${JSON.stringify(mod)} + "_" + k : undefined });`);
    }
    if (specifier === "next/navigation") return stub("export const usePathname = () => globalThis.__a2s.path;");
    if (specifier === "@/lib/wallet") {
      // the real shortAddress (lib/wallet.tsx), restated: the stub replaces only the React context
      return stub("export const useWalletUi = () => globalThis.__a2s.ui; export const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;");
    }
    if (specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => globalThis.__a2s.evm;");
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

/** The real asset page frame (components/assets/Shell.tsx) around a placeholder page. */
async function render(ctx: Ctx): Promise<string> {
  const React = appRequire("react");
  g.React = React;
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const mod = await import(pathToFileURL(ASSET_SHELL).href);
  g.__a2s = ctx;
  return renderToStaticMarkup(React.createElement(mod.default, { back: { href: "/assets", label: "Assets" } }, React.createElement("p", null, "page")));
}

function scoped(mod: string, css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\.([a-zA-Z_][\w-]*)/g, `.${mod}_$1`);
}

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

function forBrowser(path: string, windows: boolean): string {
  if (!windows) return path;
  const w = spawnSync("wslpath", ["-w", path], { encoding: "utf8" }).stdout.trim();
  assert.ok(w, `wslpath gave nothing for ${path}`);
  return w;
}

function fileUrl(path: string, windows: boolean): string {
  return windows ? "file:" + forBrowser(path, true).replace(/\\/g, "/") : pathToFileURL(path).href;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number };
type Layout = {
  width: number; inner: number; jakarta: string; bar: Box; note: Box & { scrollWidth: number; clientWidth: number; text: string };
  pill: Box | null; actions: Box; logo: Box | null;
};

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@200..800&display=swap";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function jakartaLatin(): Promise<{ url: string; bytes: Buffer }> {
  const css = await (await fetch(FONT_CSS, { headers: { "user-agent": UA } })).text();
  const block = css.split("@font-face").find((b) => b.includes("U+0000-00FF"));
  const url = block && /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
  assert.ok(url, `no latin Plus Jakarta Sans woff2 in ${FONT_CSS}`);
  const res = await fetch(url);
  assert.ok(res.ok, `font download failed: ${res.status} ${url}`);
  return { url, bytes: Buffer.from(await res.arrayBuffer()) };
}

function layouts(markup: string, widths: number[], font: Buffer): Layout[] {
  const css = "@font-face { font-family: 'Plus Jakarta Sans'; font-weight: 200 800; src: url(jakarta.woff2) format('woff2'); }\n" +
    ":root { --font-jakarta: 'Plus Jakarta Sans'; --font-archivo: Archivo; }\n" +
    readFileSync(resolve(SRC, "app/globals.css"), "utf8") + "\n" +
    // ChainMark.module.css is new in this feature: missing when this spec is run on de78a6f, the commit before it
    Object.entries(CSS_FILES).filter(([, f]) => existsSync(f)).map(([m, f]) => scoped(m, readFileSync(f, "utf8"))).join("\n");
  const probe = (w: number) => `
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
    const bar = document.querySelector('.Shell_topbar');
    const noteEl = bar.querySelector('.Shell_devnetText');
    const note = { ...box(noteEl), scrollWidth: noteEl.scrollWidth, clientWidth: noteEl.clientWidth, text: noteEl.textContent };
    const jakarta = [...document.fonts].filter((f) => f.family.includes('Jakarta')).map((f) => f.status).join(',') || 'not declared';
    const out = { width: ${w}, inner: window.innerWidth, jakarta, bar: box(bar), note, pill: box(bar.querySelector('.WalletConnect_pill')),
      actions: box(bar.querySelector('.Shell_actions')), logo: box(bar.querySelector('.Shell_logoTop')) };
    const pre = parent.document.createElement('pre'); pre.className = 'layout-out'; pre.textContent = JSON.stringify(out); parent.document.body.appendChild(pre);`;
  const frames = widths.map((w) => {
    const inner = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body>${markup}<script>document.fonts.ready.then(() => { ${probe(w)} });</script></body></html>`;
    return `<iframe width="${w}" height="500" style="border:0;display:block" srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
  });
  const outer = `<!doctype html><html><body style="margin:0">${frames.join("")}</body></html>`;
  const errors: string[] = [];
  for (const b of browsers()) {
    const dir = mkdtempSync(join(REPO, ".a2-asset-note-widths-"));
    try {
      const file = join(dir, "shell.html");
      writeFileSync(file, outer);
      writeFileSync(join(dir, "jakarta.woff2"), font);
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
const noEvm = { address: null, onRobinhood: false, walletName: null, disconnect: noop, switchToRobinhood: noop, error: null };
// a Solana wallet only: the asset pages are the Solana side's (lib/side-rules.ts gateDecision shows them with it)
const SOL = { address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", walletName: "Phantom", stage: "closed", openConnect: noop, disconnect: noop };
const CTX: Ctx = { path: "/assets/TSLAx", ui: SOL, evm: noEvm };
const MID = [560, 600, 640, 680, 720];

/** The note is laid out as running text: not on the buttons' row, and no word wider than the note. */
function squeezed(l: Layout): string | null {
  const beside = l.note.top < l.actions.bottom && l.note.bottom > l.actions.top;
  const clipped = l.note.scrollWidth > l.note.clientWidth + 0.5;
  if (!beside && !clipped) return null;
  return `${l.width}px: the note is ${l.note.width.toFixed(1)}px wide and ${(l.note.bottom - l.note.top).toFixed(1)}px tall` +
    (beside ? `, on the buttons' row (note top ${l.note.top.toFixed(1)}, buttons ${l.actions.top.toFixed(1)} to ${l.actions.bottom.toFixed(1)})` : "") +
    (clipped ? `, its words ${l.note.scrollWidth}px wide overflow it` : "");
}

describe("A2 adversary (238d644): the asset pages' chip note between phone and desktop, with the site's font", () => {
  let font: { url: string; bytes: Buffer };
  let markup: string;
  before(async () => {
    font = await jakartaLatin();
    console.log(`      font: ${font.url} (${font.bytes.length} bytes)`);
    markup = await render(CTX);
  });

  it("control: at 360, 414 and 1280px the note is running text (row two on a phone, its 240px basis on desktop)", () => {
    for (const l of layouts(markup, [360, 414, 1280], font.bytes)) {
      assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
      assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
      if (l.width < 760) assert.equal(squeezed(l), null, `control, ${l.width}px`);
      else assert.ok(l.note.width >= 240 && l.note.scrollWidth <= l.note.clientWidth, `control, ${l.width}px: ${l.note.width}`);
    }
  });

  it(`/assets/TSLAx, Solana wallet, ${MID.join(", ")}px: the "Mainnet, read only" note is not squeezed beside the wallet pill`, () => {
    const bad: string[] = [];
    for (const l of layouts(markup, MID, font.bytes)) {
      assert.equal(l.inner, l.width, "precondition: the viewport is the iframe's width");
      assert.match(l.jakarta, /^loaded/, `precondition: Plus Jakarta Sans is loaded (${l.jakarta})`);
      assert.ok(l.logo && l.logo.width > 0, "precondition: the phone layout (the top bar's logo) is in force");
      assert.ok(l.pill && l.pill.width > 0, "precondition: the Solana address pill is in the bar");
      assert.match(l.note.text, /^Real xStocks, read live from Solana mainnet/, "precondition: the asset pages' note");
      const s = squeezed(l);
      if (s) bad.push(s);
    }
    assert.deepEqual(bad, [], "the asset pages' note is squeezed into a narrow column beside the wallet pill");
  });
});
