/**
 * Adversary pass on 8e93a30 (neutral base site). Joshua, 2026-10-03, rule 2: with only an EVM wallet connected,
 * "Visiting a Solana URL directly (/assets, /assets/<symbol>, /portfolio, /circle/demo, /circle/<state>, /circle/new,
 * join and position pages, /split-lab) sends the person to the Robinhood equivalent."
 *
 * For each of those URLs this composes what Next renders below the root layout: every layout.tsx on the way from
 * app/src/app to the page's folder, then the page itself, and evaluates the element tree with an EVM wallet connected
 * and no Solana wallet. The real components/othello/SideGate.tsx, lib/side-rules.ts, lib/chains.ts and lib/nav.ts run;
 * React's useEffect, next/navigation, the two wallet hooks, the Shell, CSS modules and the pages' heavy bodies are
 * stubbed (the loader-hook pattern of tests/a2-solana-no-connect-on-load.spec.ts). A URL passes when the page body
 * is not rendered and a redirect to a /robinhood page is scheduled.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-neutral-split-lab-adversary.spec.ts   (own process: loader hooks)
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const APP = resolve(SRC, "app");
const appRequire = createRequire(resolve(REPO, "app/package.json"));

type State = { path: string; replaced: string[]; effects: (() => void | (() => void))[] };
const g = globalThis as { __ns?: State; React?: unknown };

const PAGE_BODY = "PAGE_BODY_RENDERED";
const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? "";
    const fromApp = parent.includes("/app/src/");
    if (fromApp && specifier === "react") {
      return stub(
        "export const useEffect = (f) => { globalThis.__ns.effects.push(f); };" +
        "export const useState = (i) => [typeof i === 'function' ? i() : i, () => {}];" +
        "export const useMemo = (f) => f(); export const useCallback = (f) => f; export const useRef = (i) => ({ current: i });",
      );
    }
    if (fromApp && specifier === "next/navigation") {
      return stub(
        "export const usePathname = () => globalThis.__ns.path;" +
        "export const useRouter = () => ({ replace: (to) => globalThis.__ns.replaced.push(to), push: (to) => globalThis.__ns.replaced.push(to) });",
      );
    }
    if (fromApp && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ address: null, openConnect() {} });");
    // an EVM wallet only: a sentinel, never a real address
    if (fromApp && specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => ({ address: 'evm-sentinel' });");
    if (fromApp && specifier === "@/components/othello/Shell") return stub("export default function Shell(p) { return p.children; }");
    if (fromApp && specifier.endsWith(".css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    // the pages' bodies: whatever a page renders below its own gate is the page shown to the person
    if (fromApp && parent.includes("/app/src/app/") && parent.endsWith("/page.tsx") && specifier.startsWith("@/components/") && !specifier.includes("SideGate")) {
      return stub(`export default function Body() { return '${PAGE_BODY}'; } export const __any = new Proxy({}, { get: () => () => '${PAGE_BODY}' });`);
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
        if (existsSync(base + ext) && (ext !== "" || !existsSync(base + "/index.ts"))) return next(pathToFileURL(base + ext).href, context);
      }
    }
    return next(specifier, context);
  },
});

/** The folders Next walks for a URL: a literal segment folder if there is one, else the dynamic `[x]` folder. */
function segmentDirs(url: string): string[] {
  const dirs: string[] = [];
  let dir = APP;
  for (const seg of url.split("/").filter(Boolean)) {
    const names = readdirSync(dir);
    const name = names.includes(seg) ? seg : names.find((n) => n.startsWith("[") && !n.startsWith("[["));
    assert.ok(name, `no route folder for ${seg} in ${dir}`);
    dir = join(dir, name);
    dirs.push(dir);
  }
  return dirs;
}

/** Evaluates an element tree: function components are called, host elements and fragments render their children. */
function render(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(render).join("");
  const el = node as { type: unknown; props: { children?: unknown } };
  if (typeof el.type === "function") return render((el.type as (p: unknown) => unknown)(el.props));
  return render(el.props?.children);
}

async function visit(url: string): Promise<{ html: string; replaced: string[] }> {
  const React = appRequire("react") as { createElement: (...a: unknown[]) => unknown };
  g.React = React;
  const state: State = { path: url, replaced: [], effects: [] };
  g.__ns = state;
  const dirs = segmentDirs(url);
  const pageFile = join(dirs[dirs.length - 1]!, "page.tsx");
  const Page = (await import(pathToFileURL(pageFile).href)).default as (p: unknown) => unknown;
  const params = Promise.resolve({ id: "demo", symbol: "NFLXx", seat: "0" });
  let tree: unknown = React.createElement(Page, { params, searchParams: Promise.resolve({}) });
  for (const d of [...dirs].reverse()) {
    const layout = join(d, "layout.tsx");
    if (!existsSync(layout)) continue;
    const Layout = (await import(pathToFileURL(layout).href)).default;
    tree = React.createElement(Layout, { children: tree, params });
  }
  let html: string;
  try {
    html = render(tree);
  } catch (e) {
    // an async server page (a Promise) or a hook outside the stubs: report it as rendered, never as gated
    html = `${PAGE_BODY} (render threw: ${(e as Error).message})`;
  }
  for (const f of state.effects) f();
  await new Promise((r) => setTimeout(r, 1500)); // past SideGate's SETTLE_MS (1200)
  return { html, replaced: state.replaced };
}

describe("A2 neutral site (adversary on 8e93a30): an EVM wallet alone is sent off every Solana URL Joshua listed", function () {
  this.timeout(60_000);

  it("the Split lab page is a Solana page (its body speaks of Solana devnet, Solana mainnet and the NFLXx xStock)", () => {
    const body = readFileSync(resolve(SRC, "components/splitlab/SplitLab.tsx"), "utf8");
    assert.match(body, /Reading Solana devnet\./);
    assert.match(body, /recorded from Solana mainnet/);
    assert.match(body, /href="\/assets\/NFLXx"/);
  });

  for (const url of ["/assets", "/portfolio", "/circle/new", "/split-lab"]) {
    it(`${url}: with only an EVM wallet, the page is not shown and the person is sent to a Robinhood Chain page`, async () => {
      const { html, replaced } = await visit(url);
      assert.ok(!html.includes(PAGE_BODY), `${url} rendered its Solana page to an EVM-only visitor: ${JSON.stringify(html.slice(0, 120))}`);
      assert.equal(replaced.length, 1, `${url}: expected one redirect, got ${JSON.stringify(replaced)}`);
      assert.ok(replaced[0] === "/robinhood" || replaced[0]!.startsWith("/robinhood/"), `${url} redirected to ${replaced[0]}`);
    });
  }
});
