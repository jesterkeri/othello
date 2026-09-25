/**
 * T18c adversary: the Portfolio page's xStocks total when Jupiter's price read fails.
 *
 * Requirement under test (T18c brief): "Real data or a clear error: no stale or made-up
 * number anywhere; a failed read says so." app/src/app/api/holdings/route.ts reads the
 * balances from mainnet and prices from Jupiter; when Jupiter fails it keeps the holding and
 * sets usdValue to null, which is honest. The page must then not print a dollar total for
 * holdings it could not value.
 *
 * Data: tests/fixtures/holdings-nflxx-pool.json, the exact JSON-RPC answers the route asks
 * for, recorded from public mainnet and devnet on 2026-09-25 (slots in its provenance) for
 * a real address that holds real NFLXx, plus Jupiter's real price answer for NFLXx recorded
 * the same day. The failure case answers Jupiter's price request with 429, the status
 * Jupiter's keyless API gives a burst; nothing else is changed.
 *
 * Path: fixture -> the route's own GET (global fetch stubbed) -> its JSON body ->
 * app/src/components/portfolio/Portfolio.tsx rendered with react-dom/server. The only
 * substitutions are the ones a server render needs: CSS modules become class-name stubs,
 * Shell renders its children, useWalletUi returns the owner, and Portfolio's useState
 * starts from what its useEffect fetches would have set (a server render never runs them).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
const PORTFOLIO = resolve(SRC, "components/portfolio/Portfolio.tsx");
// Anchored beside Portfolio, not on it, so the test's own requires are not redirected.
const appRequire = createRequire(resolve(SRC, "components/portfolio/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

const fx = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/holdings-nflxx-pool.json"), "utf8")) as {
  provenance: { owner: string };
  mainnet: { getTokenAccountsByOwner: unknown; getMultipleAccounts: unknown; mints: string[] };
  devnet: { mirror: unknown; testUsdc: unknown };
  jupiter: { body: unknown };
};
const OWNER = fx.provenance.owner;
const NFLXX_MIRROR = "CymeZqJiKk2Nd4FkDvHduyrq3k3XbJELtifAbPqfdSuA";

const g = globalThis as { __portfolioSeed?: unknown[]; __portfolioOwner?: string; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const fromPortfolio = context.parentURL?.includes("/components/portfolio/Portfolio.tsx") ?? false;
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
    if (fromPortfolio && specifier === "react") {
      const stub =
        `import real from ${JSON.stringify(REACT_URL)};` +
        "export default real;" +
        "export const useEffect = () => {};" +
        "export function useState(init) { return [globalThis.__portfolioSeed.shift(), () => {}]; }";
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    if (fromPortfolio && specifier === "@/components/othello/Shell") {
      return { url: "data:text/javascript,export default function Shell(p) { return p.children; }", shortCircuit: true };
    }
    if (fromPortfolio && specifier === "@/lib/wallet") {
      return {
        url: "data:text/javascript,export function useWalletUi() { return { address: globalThis.__portfolioOwner }; }",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The holdings route's own body for OWNER, with Jupiter answering `jupiter`. */
async function holdings(jupiter: () => Response): Promise<{ xstocks: { symbol: string; usdValue: number | null }[] }> {
  const route = await import(pathToFileURL(resolve(SRC, "app/api/holdings/route.ts")).href + `?t=${Math.random()}`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://lite-api.jup.ag/price/v3")) return jupiter();
    const req = JSON.parse(String(init?.body)) as { method: string; params: [string, { mint?: string }] };
    if (url.includes("devnet")) return json(req.params[1].mint === NFLXX_MIRROR ? fx.devnet.mirror : fx.devnet.testUsdc);
    if (req.method === "getTokenAccountsByOwner") return json(fx.mainnet.getTokenAccountsByOwner);
    if (req.method === "getMultipleAccounts") return json(fx.mainnet.getMultipleAccounts);
    throw new Error(`unexpected request ${url} ${req.method}`);
  }) as typeof fetch;
  const saved = { main: process.env.MAINNET_RPC_URL, dev: process.env.DEVNET_RPC_URL };
  delete process.env.MAINNET_RPC_URL;
  delete process.env.DEVNET_RPC_URL;
  try {
    const { NextRequest } = appRequire("next/server");
    const res = await route.GET(new NextRequest(`http://localhost/api/holdings?owner=${OWNER}`));
    assert.equal(res.status, 200, "the route reads the recorded balances");
    return res.json();
  } finally {
    globalThis.fetch = realFetch;
    if (saved.main !== undefined) process.env.MAINNET_RPC_URL = saved.main;
    if (saved.dev !== undefined) process.env.DEVNET_RPC_URL = saved.dev;
  }
}

/** The "Your xStocks" total card as the page renders it for that body (T18e: Portfolio.dc.html
 *  replaced the old h2 heading with this card; the claim under test is unchanged). */
async function heading(body: unknown): Promise<string> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  g.React = React;
  g.__portfolioOwner = OWNER;
  // Portfolio's four useState calls, in order: circle, circleErr, hold, holdErr.
  g.__portfolioSeed = [null, "not read in this test", body, null];
  const { default: Portfolio } = await import(pathToFileURL(PORTFOLIO).href);
  const html: string = renderToStaticMarkup(React.createElement(Portfolio));
  const at = html.indexOf('aria-label="Your xStocks"');
  assert.ok(at >= 0, "the page has a Your xStocks card");
  const card = html.slice(at, html.indexOf("</section>", at));
  return card.slice(card.indexOf(">") + 1).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("T18c adversary: Portfolio never totals holdings it could not price", () => {
  it("control: with Jupiter's real price the heading carries a dollar total", async () => {
    const body = await holdings(() => json(fx.jupiter.body));
    assert.equal(body.xstocks.length, 1);
    assert.equal(body.xstocks[0]!.symbol, "NFLXx");
    assert.ok(body.xstocks[0]!.usdValue! > 0, "valued at Jupiter's price");
    assert.match(await heading(body), /^Your xStocks · mainnet \$[1-9]/);
  });

  it("does not print a dollar total when Jupiter's price read failed", async () => {
    const body = await holdings(() => new Response("Too Many Requests", { status: 429 }));
    assert.equal(body.xstocks.length, 1, "the wallet still holds NFLXx");
    assert.equal(body.xstocks[0]!.usdValue, null, "the route says it has no value for it");
    const h = await heading(body);
    assert.doesNotMatch(h, /\$\d/, `the wallet holds real NFLXx that could not be priced, yet the page heads it "${h}"`);
  });
});
