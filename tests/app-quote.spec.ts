/**
 * /api/quote (Buy panel) against malformed and well-formed Jupiter answers (Codex T18c r1: a
 * partial answer was turned into "0.00% impact, direct route"; the quoted and reported amounts
 * could differ). The route's own GET runs with global fetch stubbed; nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx"]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* next extension */
        }
      }
    }
    return next(specifier, context);
  },
});

type Answer = { status?: number; body: unknown };

async function quote(query: string, answer: Answer): Promise<{ status: number; body: Record<string, unknown>; asked: string[] }> {
  const route = await import(pathToFileURL(resolve(SRC, "app/api/quote/route.ts")).href);
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    asked.push(String(url));
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    // The route reads only req.nextUrl, so a plain object with a URL stands in for NextRequest.
    const res = await route.GET({ nextUrl: new URL(`http://localhost/api/quote?${query}`) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, asked };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const GOOD = { outAmount: "6829690", priceImpactPct: "0.021448", routePlan: [{ swapInfo: { label: "Raydium CLMM" } }] };

describe("/api/quote: only Jupiter's own, well-formed facts reach the Buy panel", () => {
  it("passes a complete quote through: amount, impact in percent, route labels", async () => {
    const r = await quote("symbol=NFLXx&usdc=50", { body: GOOD });
    assert.equal(r.status, 200);
    assert.deepEqual(
      { outRaw: r.body.outRaw, route: r.body.route, usdc: r.body.usdc },
      { outRaw: "6829690", route: ["Raydium CLMM"], usdc: 50 },
    );
    assert.ok(Math.abs((r.body.priceImpactPct as number) - 2.1448) < 1e-9);
  });

  for (const [name, body] of [
    ["only outAmount (Codex's example)", { outAmount: "100000000" }],
    ["no price impact", { outAmount: "1", routePlan: GOOD.routePlan }],
    ["a non-numeric impact", { ...GOOD, priceImpactPct: "abc" }],
    ["a negative impact", { ...GOOD, priceImpactPct: "-0.1" }],
    ["an empty route", { ...GOOD, routePlan: [] }],
    ["a route step with no label", { ...GOOD, routePlan: [{ swapInfo: {} }] }],
    ["a non-integer out amount", { ...GOOD, outAmount: "12.5" }],
    ["a non-numeric out amount", { ...GOOD, outAmount: "abc" }],
    ["a zero out amount", { ...GOOD, outAmount: "0" }],
  ] as const) {
    it(`refuses ${name} instead of filling in a fact`, async () => {
      const r = await quote("symbol=NFLXx&usdc=50", { body });
      assert.equal(r.status, 502);
      assert.equal(r.body.error, "Jupiter returned an incomplete quote");
    });
  }

  it("quotes and reports the same amount (1.0000004 USDC is 1,000,000 micro-USDC both ways)", async () => {
    const r = await quote("symbol=NFLXx&usdc=1.0000004", { body: GOOD });
    assert.equal(r.status, 200);
    assert.equal(r.body.usdc, 1);
    assert.match(r.asked[0]!, /[?&]amount=1000000&/);
  });

  it("refuses an unlisted symbol and an out-of-range amount before asking Jupiter", async () => {
    const a = await quote("symbol=BOGUS&usdc=5", { body: GOOD });
    const b = await quote("symbol=NFLXx&usdc=0", { body: GOOD });
    assert.deepEqual([a.status, b.status, a.asked.length, b.asked.length], [404, 400, 0, 0]);
  });
});
