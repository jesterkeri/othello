/**
 * Adversary, A2 chain logos (Joshua, 2026-10-03), pass on 29dfd84. The spec: "The site has light and dark themes ...;
 * the logo must be visible and correct in both", and Robinhood Chain's feather is "feather-dark.svg black, for light
 * backgrounds; feather-light.svg white, for dark backgrounds".
 *
 * The real app/src/components/othello/Shell.tsx is rendered with react-dom/server (the app's own React) over stubbed
 * wallet contexts, with only an EVM wallet connected, so the top bar shows Robinhood Chain's feather. The real
 * Shell.module.css is then applied to that markup (CSS-module classes are stubbed to their own names, so the
 * stylesheet's selectors match the markup as written) inside the document root as app/src/app/layout.tsx renders it.
 * The feather's fill is whichever `.feather` rule matches last, and its background is the mark's var(--raised) from
 * the Shell's own theme variables (lib/theme.ts innerVars).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-chain-mark-theme-adversary.spec.ts
 *
 * Installs module loader hooks: run in its own mocha process.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { PALETTES, innerVars } from "../app/src/lib/theme.ts";

const SRC = resolve(REPO, "app/src");
const SHELL = resolve(SRC, "components/othello/Shell.tsx");
const SHELL_CSS = resolve(SRC, "components/othello/Shell.module.css");
// Fix pass on 8e2f834: the mark's styles moved to ChainMark.module.css (shared with Landing); the cascade reads both
const MARK_CSS = resolve(SRC, "components/othello/ChainMark.module.css");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Ctx = { ui: Record<string, unknown>; evm: Record<string, unknown>; path: string };
const g = globalThis as { __a2m?: Ctx; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? "";
    const fromShell = parent.endsWith("/components/othello/Shell.tsx");
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (fromShell && specifier === "./StockSearch") return stub("export default function StockSearch() { return null; }");
    if (fromShell && specifier === "./WalletConnect") return stub("export function WalletControl() { return null; }");
    if (specifier === "next/navigation") return stub("export const usePathname = () => globalThis.__a2m.path;");
    if (specifier === "@/lib/wallet") return stub("export const useWalletUi = () => globalThis.__a2m.ui;");
    if (specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => globalThis.__a2m.evm;");
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

async function renderShell(ctx: Ctx): Promise<string> {
  const React = appRequire("react");
  g.React = React;
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const mod = await import(pathToFileURL(SHELL).href);
  g.__a2m = ctx;
  return renderToStaticMarkup(React.createElement(mod.default, { active: "Circles" }, React.createElement("p", null, "page")));
}

/* ------------------------------------------------ a small cascade for the markup above ------------------------------------------------ */

type El = { tag: string; attrs: Record<string, string>; parent: El | null };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Every element of well-formed react-dom/server markup, with its parent chain. */
function elements(html: string, root: El): El[] {
  const out: El[] = [];
  const stack: El[] = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g)) {
    const [, close, tag, rawAttrs, self] = m;
    if (close) { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs!.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]!] = a[2] ?? "";
    const el: El = { tag: tag!.toLowerCase(), attrs, parent: stack[stack.length - 1]! };
    out.push(el);
    if (!self && !VOID.has(el.tag)) stack.push(el);
  }
  return out;
}

/** One compound selector (".a", "[x='y']", "tag", or a mix) against one element. */
function compoundMatches(sel: string, el: El): boolean {
  const parts = sel.match(/\.[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*/g) ?? [];
  // a pseudo-class or anything else this does not model (:hover, ::before, :is(...)) does not hold in the static markup
  if (parts.join("") !== sel) return false;
  return parts.every((p) => {
    if (p.startsWith(".")) return (el.attrs["class"] ?? "").split(/\s+/).includes(p.slice(1));
    if (p.startsWith("[")) {
      const a = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p)!;
      return a[2] === undefined ? a[1]! in el.attrs : el.attrs[a[1]!] === a[2];
    }
    return el.tag === p.toLowerCase();
  });
}

/** A descendant-combinator selector, CSS modules' :global(...) unwrapped. */
function matches(selector: string, el: El): boolean {
  const compounds = selector.replace(/:global\(([^)]*)\)/g, "$1").replace(/[>+~]/g, " ").trim().split(/\s+/);
  let cur: El | null = el;
  if (!compoundMatches(compounds[compounds.length - 1]!, cur)) return false;
  for (let i = compounds.length - 2; i >= 0; i--) {
    cur = cur.parent;
    while (cur && !compoundMatches(compounds[i]!, cur)) cur = cur.parent;
    if (!cur) return false;
  }
  return true;
}

/** The value `prop` takes on `el` from the top-level rules of `css` (source order; no rule here uses !important). */
function cascaded(css: string, el: El, prop: string): string | null {
  let value: string | null = null;
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "");
  for (const r of flat.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(r[2]!);
    if (!decl) continue;
    if (r[1]!.split(",").some((s) => matches(s.trim(), el))) value = decl[1]!.trim();
  }
  return value;
}

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, gg, bb] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * gg! + 0.0722 * bb!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const noop = () => {};
const ui = { address: null, walletName: null, stage: "closed", openConnect: noop, disconnect: noop };
const evm = { address: "0x1111111111111111111111111111111111111111", onRobinhood: true, walletName: "MetaMask", disconnect: noop };

describe("A2 adversary (29dfd84): Robinhood Chain's feather in the Shell's dark mode", () => {
  it("only MetaMask, Shell in dark mode (its default): the feather is white on the dark mark, not black", async () => {
    const html = await renderShell({ path: "/robinhood", ui, evm });
    const css = readFileSync(SHELL_CSS, "utf8") + "\n" + readFileSync(MARK_CSS, "utf8");

    // the document root as app/src/app/layout.tsx renders it: <html lang class> with no data-theme on load
    const doc: El = { tag: "html", attrs: { lang: "en", class: "" }, parent: null };
    const body: El = { tag: "body", attrs: {}, parent: doc };
    const els = elements(html, body);
    const root = els.find((e) => (e.attrs["class"] ?? "").split(/\s+/).includes("root"))!;
    assert.equal(root.attrs["data-mode"], "dark", "precondition: the Shell renders in dark mode first (useTheme's default)");
    const feather = els.find((e) => e.tag === "path" && (e.attrs["class"] ?? "").split(/\s+/).includes("feather"));
    assert.ok(feather, "precondition: the top bar shows Robinhood Chain's feather with only MetaMask connected");

    // the mark's background: .chainMark { background: var(--raised) }, from the Shell's own dark variables
    const slot = els.find((e) => (e.attrs["class"] ?? "").split(/\s+/).includes("chainMark"))!;
    assert.equal(cascaded(css, slot, "background"), "var(--raised)");
    const raised = innerVars(PALETTES[1]!, true)["--raised"]!;

    const fill = cascaded(css, feather, "fill");
    assert.ok(fill && /^#[0-9a-fA-F]{6}$/.test(fill), `the feather's fill resolved to ${fill}`);
    const ratio = contrast(fill, raised);
    assert.equal(
      fill.toUpperCase(),
      "#FFFFFF",
      `dark mode: the feather is ${fill} on ${raised} (contrast ${ratio.toFixed(2)}:1); the white feather (feather-light.svg) is the one for dark backgrounds`,
    );
  });

  it("Shell in light mode, even after Landing wrote <html data-theme=\"dark\">: the feather is black on the light mark", async () => {
    // Fix pass: the colour follows the Shell's own data-mode, so a stale document theme from Landing must not flip it
    const html = await renderShell({ path: "/robinhood", ui, evm });
    const css = readFileSync(SHELL_CSS, "utf8") + "\n" + readFileSync(MARK_CSS, "utf8");
    const doc: El = { tag: "html", attrs: { lang: "en", class: "", "data-theme": "dark" }, parent: null };
    const body: El = { tag: "body", attrs: {}, parent: doc };
    const els = elements(html, body);
    const root = els.find((e) => (e.attrs["class"] ?? "").split(/\s+/).includes("root"))!;
    assert.equal(root.attrs["data-mode"], "dark", "precondition: rendered dark first");
    // the Shell after the person picks light: every data-mode in the frame comes from the same useTheme t.mode
    // (.root and, since the fix pass on 8e2f834, the mark's own slot), so all of them switch together
    const moded = els.filter((e) => e.attrs["data-mode"] !== undefined);
    assert.ok(moded.length >= 1);
    for (const e of moded) e.attrs["data-mode"] = "light";
    const feather = els.find((e) => e.tag === "path" && (e.attrs["class"] ?? "").split(/\s+/).includes("feather"))!;
    const raised = innerVars(PALETTES[1]!, false)["--raised"]!;
    const fill = cascaded(css, feather, "fill")!;
    assert.equal(fill.toUpperCase(), "#000000", `light mode: the feather is ${fill} on ${raised}; feather-dark.svg (black) is the one for light backgrounds`);
  });
});
