/**
 * Adversary pass on cefd1ab. Spec (Joshua, 2026-10-03): with only the other chain's wallet the person is sent to a
 * Robinhood Chain page (for a Solana route). /split-lab is Solana only: lib/nav.ts sends an EVM-only visitor to
 * "/robinhood", which lib/side-rules.ts labelOf calls "Circles" (the Robinhood circles home). The status line the
 * person reads while waiting must say where they are going, not promise a Robinhood Chain split lab that does not exist.
 *
 * This renders the real RouteGate (components/othello/SideGate.tsx) on /split-lab with only an EVM wallet; React's
 * hooks, next/navigation, the wallet hooks, Shell and CSS are stubbed (the loader-hook pattern of
 * tests/a2-gate-menu-item-adversary.spec.ts).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-split-lab-redirect-copy-adversary.spec.ts   (own process: loader hooks)
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(REPO, "app/package.json"));

const g = globalThis as { __sl?: { path: string; active: unknown[] }; React?: unknown };
const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });

registerHooks({
  resolve(specifier, context, next) {
    const fromApp = (context.parentURL ?? "").includes("/app/src/");
    if (fromApp && specifier === "react") {
      return stub(
        "export const useEffect = () => {};" +
        "export const useState = (i) => [typeof i === 'function' ? i() : i, () => {}];" +
        "export const useMemo = (f) => f(); export const useCallback = (f) => f; export const useRef = (i) => ({ current: i });",
      );
    }
    if (fromApp && specifier === "next/navigation") {
      return stub("export const usePathname = () => globalThis.__sl.path; export const useRouter = () => ({ replace() {}, push() {} });");
    }
    // only an EVM wallet connected
    if (fromApp && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ address: null, openConnect() {} });");
    if (fromApp && specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => ({ address: '0x000000000000000000000000000000000000dEaD' });");
    if (fromApp && specifier === "@/components/othello/Shell") {
      return stub("export default function Shell(p) { globalThis.__sl.active.push(p.active); return p.children; }");
    }
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

function render(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(render).join("");
  const el = node as { type: unknown; props: { children?: unknown } };
  if (typeof el.type === "function") return render((el.type as (p: unknown) => unknown)(el.props));
  return render(el.props?.children);
}

describe("A2 adversary on cefd1ab: an EVM-only visitor on /split-lab is told where they are actually going", function () {
  this.timeout(60_000);

  it("the redirect goes to the Robinhood circles, and the status line does not promise a Robinhood Chain split lab", async () => {
    const React = appRequire("react") as { createElement: (...a: unknown[]) => unknown };
    g.React = React;
    g.__sl = { path: "/split-lab", active: [] };
    const { gateDecision, labelOf } = await import(pathToFileURL(resolve(SRC, "lib/side-rules.ts")).href);
    const decision = gateDecision("solana", labelOf("/split-lab"), { solana: false, robinhood: true });
    // not vacuous: the person really is sent to the Robinhood circles home, which has no split lab
    assert.deepEqual(decision, { show: "redirect", to: "/robinhood" });
    assert.equal(labelOf("/robinhood"), "Circles");

    const { RouteGate } = await import(pathToFileURL(resolve(SRC, "components/othello/SideGate.tsx")).href);
    const text = render(React.createElement(RouteGate, { children: "PAGE_BODY" }));
    assert.ok(!text.includes("PAGE_BODY"), "the Solana page rendered for an EVM-only visitor");
    assert.match(text, /Robinhood Chain/, `not vacuous: the redirect status rendered: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /split lab on Robinhood Chain/i, `status line promises a split lab that Robinhood Chain does not have: ${JSON.stringify(text)}`);
  });
});
