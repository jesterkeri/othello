/**
 * Adversary pass on 6c78baa. Spec: every sentence the gate shows is true in every state it can be shown in (each
 * gated kind, including Portfolio) and names only what the visitor can reach. Robinhood Chain has no portfolio page:
 * lib/nav.ts sends Portfolio on the robinhood side to its own /robinhood/portfolio route, which must be a real EVM page.
 * The no-wallet gate on /portfolio still says "Connect a wallet to see your portfolio." next to "An EVM wallet such as
 * MetaMask opens Robinhood Chain testnet", so a person who connects MetaMask is promised a portfolio and gets the
 * circles home: the split lab defect fixed on 6c78baa, left in place for Portfolio.
 *
 * Renders the real RouteGate (components/othello/SideGate.tsx) on /portfolio with no wallet; stubs as in
 * tests/a2-split-lab-redirect-copy-adversary.spec.ts.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-portfolio-gate-copy-adversary.spec.ts   (own process: loader hooks)
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
    // no wallet connected
    if (fromApp && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ address: null, openConnect() {} });");
    if (fromApp && specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => ({ address: null });");
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

describe("A2 adversary on 6c78baa: the no-wallet portfolio gate promises only what an EVM wallet can open", function () {
  this.timeout(60_000);

  it("sends an EVM wallet to the Robinhood portfolio it promises", async () => {
    const React = appRequire("react") as { createElement: (...a: unknown[]) => unknown };
    g.React = React;
    g.__sl = { path: "/portfolio", active: [] };
    const { gateDecision, labelOf } = await import(pathToFileURL(resolve(SRC, "lib/side-rules.ts")).href);
    // not vacuous: no wallet gives the gate, and an EVM wallet afterwards lands on the Robinhood portfolio.
    assert.deepEqual(gateDecision("solana", labelOf("/portfolio"), { solana: false, robinhood: false }), { show: "connect" });
    assert.deepEqual(gateDecision("solana", labelOf("/portfolio"), { solana: false, robinhood: true }), { show: "redirect", to: "/robinhood/portfolio" });
    assert.equal(labelOf("/robinhood/portfolio"), "Portfolio");

    const { RouteGate } = await import(pathToFileURL(resolve(SRC, "components/othello/SideGate.tsx")).href);
    const text = render(React.createElement(RouteGate, { children: "PAGE_BODY" }));
    assert.ok(!text.includes("PAGE_BODY"), "the Solana page rendered with no wallet");
    assert.match(text, /MetaMask opens Robinhood Chain testnet/, `not vacuous: the gate offers an EVM wallet: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /to see your portfolio/i, `gate promises a portfolio that Robinhood Chain does not have: ${JSON.stringify(text)}`);
  });
});
