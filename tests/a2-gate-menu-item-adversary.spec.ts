/**
 * Adversary pass on 856f0d8. Spec (Joshua, 2026-10-03): "The menu shows a gated page under its menu item (starting a
 * circle is under Circles)." Split lab sits under How it works (app/src/components/splitlab/SplitLab.tsx: "Split lab
 * is part of How it works in the five-item nav (Joshua, 2026-09-25)", and the page renders <Shell active="How it
 * works">). app/src/app/split-lab/layout.tsx returns <RouteGate>, so with no wallet the person sees the gate instead.
 *
 * This renders each URL's layouts and page with no wallet connected, the real SideGate, side-rules, chains and nav;
 * React's hooks, next/navigation, the wallet hooks and CSS are stubbed (the loader-hook pattern of
 * tests/a2-neutral-split-lab-adversary.spec.ts), and the Shell stub records the menu item it is told is active.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-gate-menu-item-adversary.spec.ts   (own process: loader hooks)
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

type State = { path: string; active: unknown[]; titles: string[] };
const g = globalThis as { __gm?: State; React?: unknown };

const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? "";
    const fromApp = parent.includes("/app/src/");
    if (fromApp && specifier === "react") {
      return stub(
        "export const useEffect = () => {};" +
        "export const useState = (i) => [typeof i === 'function' ? i() : i, () => {}];" +
        "export const useMemo = (f) => f(); export const useCallback = (f) => f; export const useRef = (i) => ({ current: i });",
      );
    }
    if (fromApp && specifier === "next/navigation") {
      return stub("export const usePathname = () => globalThis.__gm.path; export const useRouter = () => ({ replace() {}, push() {} });");
    }
    // no wallet on either side
    if (fromApp && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ address: null, openConnect() {} });");
    if (fromApp && specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => ({ address: null });");
    if (fromApp && specifier === "@/components/othello/Shell") {
      return stub("export default function Shell(p) { globalThis.__gm.active.push(p.active); return p.children; }");
    }
    if (fromApp && specifier.endsWith(".css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (fromApp && parent.includes("/app/src/app/") && parent.endsWith("/page.tsx") && specifier.startsWith("@/components/") && !specifier.includes("SideGate")) {
      return stub("export default function Body() { return 'PAGE_BODY'; } export const __any = new Proxy({}, { get: () => () => 'PAGE_BODY' });");
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

function render(node: unknown, titles: string[]): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => render(n, titles)).join("");
  const el = node as { type: unknown; props: { children?: unknown; className?: string } };
  if (typeof el.type === "function") return render((el.type as (p: unknown) => unknown)(el.props), titles);
  const out = render(el.props?.children, titles);
  if (el.type === "h1") titles.push(out);
  return out;
}

async function visit(url: string): Promise<State & { html: string }> {
  const React = appRequire("react") as { createElement: (...a: unknown[]) => unknown };
  g.React = React;
  const state: State = { path: url, active: [], titles: [] };
  g.__gm = state;
  const dirs = segmentDirs(url);
  const Page = (await import(pathToFileURL(join(dirs[dirs.length - 1]!, "page.tsx")).href)).default;
  const params = Promise.resolve({ id: "demo", symbol: "NFLXx", seat: "0" });
  let tree: unknown = React.createElement(Page, { params, searchParams: Promise.resolve({}) });
  for (const d of [...dirs].reverse()) {
    const layout = join(d, "layout.tsx");
    if (!existsSync(layout)) continue;
    tree = React.createElement((await import(pathToFileURL(layout).href)).default, { children: tree, params });
  }
  const html = render(tree, state.titles);
  return { ...state, html };
}

describe("A2 adversary on 856f0d8: with no wallet, a gated page's menu shows the page's own menu item", function () {
  this.timeout(60_000);

  it("not vacuous: Split lab's own page sits under How it works, and its folder is gated", () => {
    assert.match(readFileSync(resolve(SRC, "components/splitlab/SplitLab.tsx"), "utf8"), /<Shell active="How it works"/);
    assert.match(readFileSync(resolve(APP, "split-lab/layout.tsx"), "utf8"), /return <RouteGate>\{children\}<\/RouteGate>;/);
  });

  for (const [url, item] of [["/circle/new", "Circles"], ["/robinhood/new", "Circles"], ["/assets", "Assets"], ["/split-lab", "How it works"]] as const) {
    it(`${url}: the gate highlights ${item}`, async () => {
      const { html, active, titles } = await visit(url);
      assert.ok(!html.includes("PAGE_BODY"), `${url}: page body rendered with no wallet`);
      assert.deepEqual(active, [item], `${url}: the gate's menu item (gate title ${JSON.stringify(titles)})`);
    });
  }
});
