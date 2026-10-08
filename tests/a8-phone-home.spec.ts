/**
 * Joshua, 2026-10-08: no landing page on phones; on a phone the home page opens the circles ("circles for now").
 * Desktop keeps the landing.
 *
 * Renders the real app/page.tsx with React's hooks, next/navigation, the wallet hooks, Landing and CSS stubbed (the
 * loader-hook pattern of tests/a2-split-lab-redirect-copy-adversary.spec.ts), and a window whose matchMedia answers
 * as a phone or a desktop. And checks the CSS hides the landing at exactly the width the page redirects at.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a8-phone-home.spec.ts   (own process: loader hooks)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(REPO, "app/package.json"));

type Query = { media: string; matches: boolean; listeners: (() => void)[] };
const g = globalThis as {
  __ph?: { replaced: string[]; queries: Query[]; cleanups: (() => void)[] };
  React?: unknown;
  window?: unknown;
};
const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });

registerHooks({
  resolve(specifier, context, next) {
    const fromApp = (context.parentURL ?? "").includes("/app/src/");
    if (fromApp && specifier === "react") {
      return stub(
        "export const useEffect = (f) => { const c = f(); if (c) globalThis.__ph.cleanups.push(c); };" +
          "export const useState = (i) => [typeof i === 'function' ? i() : i, () => {}];" +
          "export const useMemo = (f) => f(); export const useCallback = (f) => f; export const useRef = (i) => ({ current: i });",
      );
    }
    if (fromApp && specifier === "next/navigation") {
      return stub("export const usePathname = () => '/'; export const useRouter = () => ({ replace(to) { globalThis.__ph.replaced.push(to); }, push() {} });");
    }
    if (fromApp && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ address: null, openConnect() {} });");
    if (fromApp && specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => ({ address: null });");
    if (fromApp && specifier === "@/components/landing/Landing") return stub("export default function Landing() { return 'LANDING'; }");
    if (fromApp && specifier.endsWith(".css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
        if (existsSync(base + ext) && (ext !== "" || !existsSync(base + "/index.ts"))) return next(pathToFileURL(base + ext).href, context);
      }
    }
    return next(specifier, context);
  },
});

type El = { type: unknown; props: { children?: unknown; className?: string } };

/** Renders the page at a width: `phone` answers matchMedia. Returns the tree, what was replaced, and the query. */
async function renderAt(phone: boolean) {
  const React = appRequire("react") as { createElement: (...a: unknown[]) => unknown };
  g.React = React;
  g.__ph = { replaced: [], queries: [], cleanups: [] };
  g.window = {
    matchMedia: (media: string) => {
      const q: Query & { addEventListener: unknown; removeEventListener: unknown } = {
        media,
        matches: phone,
        listeners: [],
        addEventListener: (_t: string, f: () => void) => q.listeners.push(f),
        removeEventListener: (_t: string, f: () => void) => (q.listeners = q.listeners.filter((x) => x !== f)),
      };
      g.__ph!.queries.push(q);
      return q;
    },
  };
  const { default: Page } = await import(pathToFileURL(resolve(SRC, "app/page.tsx")).href);
  const tree = (Page as () => El)();
  return { tree, ...g.__ph };
}

describe("A8: no landing page on phones", function () {
  this.timeout(60_000);

  it("on a phone, the home page goes straight to /circles", async () => {
    const { replaced, queries } = await renderAt(true);
    assert.deepEqual(replaced, ["/circles"]);
    assert.equal(queries[0]!.media, "(max-width: 759px)");
  });

  it("on a desktop, the landing shows and nothing redirects", async () => {
    const { tree, replaced } = await renderAt(false);
    assert.deepEqual(replaced, []);
    assert.equal(tree.props.className, "home");
    const child = tree.props.children as El;
    assert.equal((child.type as () => string)(), "LANDING", "the landing is the page's content");
  });

  it("a desktop window narrowed to phone width goes to /circles (the landing is hidden there), and the listener is removed on unmount", async () => {
    const { replaced, queries, cleanups } = await renderAt(false);
    const q = queries[0]!;
    assert.equal(q.listeners.length, 1);
    q.matches = true;
    q.listeners[0]!();
    assert.deepEqual(replaced, ["/circles"]);
    for (const c of cleanups) c();
    assert.equal(q.listeners.length, 0);
  });

  it("the CSS hides the landing at exactly the width the page redirects at, and nowhere wider", async () => {
    const css = readFileSync(resolve(SRC, "app/home.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const { PHONE } = await import(pathToFileURL(resolve(SRC, "lib/phone.ts")).href);
    const width = /max-width: (\d+)px/.exec(PHONE as string)![1];
    const media = [...css.matchAll(/@media \(max-width: (\d+)px\)\s*\{\s*\.home\s*\{\s*display:\s*none;?\s*\}\s*\}/g)];
    assert.equal(media.length, 1, `one phone rule hiding .home: ${css}`);
    assert.equal(media[0]![1], width, "the CSS and the redirect disagree on the phone width");
    assert.match(css, /^\s*\.home\s*\{\s*display:\s*contents;?\s*\}/m, "outside the phone width the wrapper must not change the landing's layout");
  });
});
