/**
 * Codex T18d r2 on the redesigned Portfolio (Portfolio.dc.html):
 * - MAJOR: a holding's u64 raw balance went through a JS Number (9007199254740993 became
 *   ...992) and the pre-multiplier amount was labelled "raw" (SPEC.md:33: raw is base units).
 *   The row must show every digit, and "what your wallet shows" from the integer.
 * - MINOR: the non-member circle card said "anyone can release a pot" with no condition.
 * Rendered with react-dom/server through the harness of app-portfolio-adversary.spec.ts
 * (same hooks, same substitutions).
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


import { CIRCLE_STATES } from "../app/src/fixtures/circles.ts";

async function render(seed: unknown[]): Promise<string> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  g.React = React;
  g.__portfolioOwner = OWNER;
  // Portfolio's useState calls, in order: circle, circleErr, hold, holdErr, how.
  g.__portfolioSeed = [...seed, false];
  const { default: Portfolio } = await import(pathToFileURL(PORTFOLIO).href);
  return (renderToStaticMarkup(React.createElement(Portfolio)) as string).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

const BIG = "9007199254740993"; // 2^53 + 1: the first integer a JS Number cannot hold
const hold = (raw: string) => ({
  owner: OWNER,
  readAt: 1,
  xstocks: [{ symbol: "NFLXx", name: "Netflix xStock", address: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL", raw, decimals: 8, shown: Number(raw) / 1e8, usdValue: 1, multiplier: 1 }],
  devnet: { mirrorRaw: BIG, testUsdc: "123456789012345678" },
});

describe("Codex T18d r2: Portfolio's figures are exact and its copy conditional", () => {
  it("shows a u64 balance above 2^53 digit for digit, before and after the multiplier", async () => {
    const text = await render([null, "not read here", hold(BIG), null]);
    assert.match(text, /90,071,992\.54740993 before the multiplier/);
    assert.match(text, /= 90,071,992\.54740993/);
    assert.doesNotMatch(text, /54740992/, "a digit came from a rounded Number");
  });

  it("labels the pre-multiplier amount as tokens, not as raw base units", async () => {
    const text = await render([null, "not read here", hold("100000000"), null]);
    assert.match(text, /1\.00000000 before the multiplier/);
    assert.doesNotMatch(text, /1\.000000 raw/);
  });

  it("shows the demo tokens exactly", async () => {
    const text = await render([null, "not read here", hold("100000000"), null]);
    assert.match(text, /90,071,992\.54740993 NFLXx devnet mirror/);
    assert.match(text, /123,456,789,012\.345678 Othello test USDC/);
  });

  it("does not tell a non-member that anyone can release a pot without its conditions", async () => {
    const view = { ...CIRCLE_STATES.active };
    const text = await render([{ view }, null, hold("100000000"), null]);
    assert.match(text, /Not in a circle yet/);
    assert.doesNotMatch(text, /move it on: anyone can release a pot/);
    assert.match(text, /once every seat has paid and the program's checks pass, anyone can release the pot/);
  });
  it("floors the multiplier exactly as the program does (Codex T18d r3: AAPLx 1.0026642075893797)", async () => {
    const { shownTokens } = await import(pathToFileURL(resolve(SRC, "lib/format.ts")).href);
    assert.equal(shownTokens("10000000000", 8, 1.0026642075893797), "100.26642070");
  });
});
