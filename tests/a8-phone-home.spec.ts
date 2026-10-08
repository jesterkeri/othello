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
  __ph?: { replaced: string[]; queries: Query[]; cleanups: (() => void)[]; state: unknown; set: unknown[] };
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
          "export const useState = (i) => [globalThis.__ph.state ?? (typeof i === 'function' ? i() : i), (v) => globalThis.__ph.set.push(v)];" +
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

/**
 * Renders the page at a width: `phone` answers matchMedia; `known` is the page's own phone state (as after its effect
 * set it). Returns the tree, what was replaced, the queries, and what the page set its state to.
 */
async function renderAt(phone: boolean, known?: boolean) {
  const React = appRequire("react") as { createElement: (...a: unknown[]) => unknown };
  g.React = React;
  g.__ph = { replaced: [], queries: [], cleanups: [], state: known, set: [] };
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

/** Every element in a tree, functions left unrendered (Landing is a stub component). */
function elements(node: unknown): El[] {
  if (node === null || node === undefined || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as El;
  return [el, ...elements(el.props?.children)];
}
const LandingIn = (tree: unknown) => elements(tree).some((e) => typeof e.type === "function" && (e.type as () => unknown)() === "LANDING");
const text = (tree: unknown) =>
  elements(tree)
    .flatMap((e) => (Array.isArray(e.props?.children) ? e.props.children : [e.props?.children]))
    .filter((c) => typeof c === "string")
    .join(" ");

describe("A8: no landing page on phones", function () {
  this.timeout(60_000);

  it("on a phone, the home page goes straight to /circles, and marks itself a phone", async () => {
    const { replaced, queries, set } = await renderAt(true);
    assert.deepEqual(replaced, ["/circles"]);
    assert.deepEqual(set, [true]);
    assert.equal(queries[0]!.media, "(max-width: 759px)");
  });

  it("before it knows the width (the prerender), the page carries the landing AND the opening line with a plain link to /circles", async () => {
    const { tree } = await renderAt(false);
    assert.ok(LandingIn(tree), "the landing is in the prerender");
    assert.ok(elements(tree).some((e) => e.props?.className === "home"), "the landing sits in the wrapper the CSS hides on phones");
    const main = elements(tree).find((e) => e.type === "main")!;
    assert.equal(main.props.className, "phone");
    assert.match(text(main), /Opening your circles/);
    const link = elements(main).find((e) => e.type === "a") as El & { props: { href?: string } };
    assert.equal(link?.props.href, "/circles", "a phone with no JavaScript can still get to the circles");
  });

  it("on a desktop, nothing redirects and the page stays as prerendered", async () => {
    const { tree, replaced, set } = await renderAt(false);
    assert.deepEqual(replaced, []);
    assert.deepEqual(set, []);
    assert.ok(LandingIn(tree));
  });

  it("once it knows it is a phone, the landing is gone (its theme effects never run) and the opening line shows at any width", async () => {
    const { tree } = await renderAt(true, true);
    assert.ok(!LandingIn(tree), "the landing is still mounted on a phone");
    const main = elements(tree).find((e) => e.type === "main")!;
    assert.equal(main.props.className, "phone known");
    assert.match(text(main), /Opening your circles/);
  });

  it("a desktop window narrowed to phone width goes to /circles, and the listener is removed on unmount", async () => {
    const { replaced, queries, cleanups, set } = await renderAt(false);
    const q = queries[0]!;
    assert.equal(q.listeners.length, 1);
    q.matches = true;
    q.listeners[0]!();
    assert.deepEqual(replaced, ["/circles"]);
    assert.deepEqual(set, [true]);
    for (const c of cleanups) c();
    assert.equal(q.listeners.length, 0);
  });

  it("the CSS swaps the two views at exactly the width the page redirects at", async () => {
    const css = readFileSync(resolve(SRC, "app/home.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const { PHONE } = await import(pathToFileURL(resolve(SRC, "lib/phone.ts")).href);
    const width = /max-width: (\d+)px/.exec(PHONE as string)![1];
    const media = [...css.matchAll(/@media \(max-width: (\d+)px\)\s*\{\s*\.home\s*\{\s*display:\s*none;?\s*\}\s*\.phone\s*\{\s*display:\s*flex;?\s*\}\s*\}/g)];
    assert.equal(media.length, 1, `one phone rule hiding .home and showing .phone: ${css}`);
    assert.equal(media[0]![1], width, "the CSS and the redirect disagree on the phone width");
    assert.match(css, /^\s*\.home\s*\{\s*display:\s*contents;?\s*\}/m, "outside the phone width the wrapper must not change the landing's layout");
    assert.match(css, /^\s*\.phone\s*\{\s*display:\s*none;?\s*\}/m, "the opening line must not show on a desktop");
    assert.match(css, /^\s*\.phone\.known\s*\{\s*display:\s*flex;?\s*\}/m);
  });
});
