/**
 * A3 (Joshua, 2026-10-04): the Robinhood Assets page shows the five Stock Tokens Robinhood's testnet faucet sends, and
 * the release gate pins exactly those addresses next to USDG.
 *
 *   npx mocha --import=tsx tests/a3-testnet-stocks.spec.ts
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./artifacts.ts";
import { BUNDLE_ADDRESS_ALLOWLIST, TESTNET_STOCK_TOKENS as PINNED, USDG, testnetStocksMatch } from "../ops/trust-config.ts";
import { STOCK_TOKENS } from "../app/src/lib/robinhood/stock-tokens.ts";
import { TESTNET_FAUCET, TESTNET_STOCK_DECIMALS, TESTNET_STOCK_TOKENS } from "../app/src/lib/robinhood/testnet-stocks.ts";

describe("A3: Robinhood Stock Tokens on testnet", () => {
  it("the page's list is the gate's pinned set, and the gate check passes", async () => {
    assert.deepEqual(TESTNET_STOCK_TOKENS.map((t) => t.address.toLowerCase()).sort(), PINNED.map((a) => a.toLowerCase()).sort());
    assert.deepEqual(await testnetStocksMatch(), []);
  });

  it("the bundle allowlist is USDG, the two placeholders and the five tokens, nothing else", () => {
    const want = new Set(["0x0000000000000000000000000000000000000000", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", USDG.toLowerCase(), ...PINNED.map((a) => a.toLowerCase())]);
    assert.deepEqual([...BUNDLE_ADDRESS_ALLOWLIST].sort(), [...want].sort());
  });

  it("the five are the faucet's tickers, each in Robinhood's registry with the same name, 18 decimals", () => {
    assert.deepEqual(TESTNET_STOCK_TOKENS.map((t) => t.symbol).sort(), ["AMD", "AMZN", "NFLX", "PLTR", "TSLA"]);
    for (const t of TESTNET_STOCK_TOKENS) {
      const reg = STOCK_TOKENS.find(([sym]) => sym === t.symbol);
      assert.ok(reg, `${t.symbol} is in Robinhood's registry`);
      assert.equal(reg![1], t.name, `${t.symbol}'s name matches the registry`);
    }
    assert.equal(TESTNET_STOCK_DECIMALS, 18);
    assert.equal(TESTNET_FAUCET, "https://faucet.testnet.chain.robinhood.com");
  });

  it("an inner page exists for the testnet tokens only (a mainnet-only token has none)", () => {
    const dir = join(REPO, "app/src/app/robinhood/assets");
    assert.deepEqual(readdirSync(dir).sort(), ["[symbol]", "page.tsx"]);
  });
});
