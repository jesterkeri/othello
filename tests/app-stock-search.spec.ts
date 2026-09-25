/**
 * T18g: the Shell's top-bar search (components/othello/StockSearch.tsx) finds listed xStocks by
 * symbol or company name, starts-with matches first, and flags only the four a circle accepts.
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
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
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

type Entry = { symbol: string; name: string; slot: string; cover: boolean };
const load = async () => (await import(pathToFileURL(resolve(SRC, "components/othello/StockSearch.tsx")).href)) as { matchStocks: (l: Entry[], q: string) => Entry[] };
const { TRADABLE_XSTOCKS } = await import(pathToFileURL(resolve(SRC, "lib/xstocks.ts")).href);
const index: Entry[] = (TRADABLE_XSTOCKS as { symbol: string; name: string }[]).map((x) => ({ ...x, slot: "acid", cover: ["SPYx", "NVDAx", "AAPLx", "NFLXx"].includes(x.symbol) }));

describe("T18g: top-bar stock search", () => {
  it("finds a stock by company name", async () => {
    const { matchStocks } = await load();
    assert.equal(matchStocks(index, "tesla")[0]?.symbol, "TSLAx");
  });
  it("finds a stock by symbol, starts-with first, case-insensitive", async () => {
    const { matchStocks } = await load();
    assert.equal(matchStocks(index, "nvda")[0]?.symbol, "NVDAx");
  });
  it("returns nothing for an empty query or a non-match", async () => {
    const { matchStocks } = await load();
    assert.deepEqual(matchStocks(index, "   "), []);
    assert.deepEqual(matchStocks(index, "zzzz-no-such"), []);
  });
});
