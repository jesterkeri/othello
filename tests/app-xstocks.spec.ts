/**
 * The buyable-xStocks registry (app/src/lib/xstocks.ts) against the program's allowlist and itself.
 */
import assert from "node:assert/strict";

import { REAL_XSTOCKS } from "../app/src/lib/devnet.ts";
import { TRADABLE_XSTOCKS } from "../app/src/lib/xstocks.ts";

describe("xStocks registry", () => {
  it("lists every collateral mint (the program's allowlist) by the same address and symbol", () => {
    for (const x of REAL_XSTOCKS) {
      const hit = TRADABLE_XSTOCKS.find((t) => t.address === x.address);
      assert.ok(hit, `${x.symbol} (${x.address}) is collateral but not listed`);
      assert.equal(hit.symbol, x.symbol);
    }
  });

  it("has no duplicate address or symbol, and every address is a base58 public key", () => {
    assert.equal(new Set(TRADABLE_XSTOCKS.map((x) => x.address)).size, TRADABLE_XSTOCKS.length);
    assert.equal(new Set(TRADABLE_XSTOCKS.map((x) => x.symbol)).size, TRADABLE_XSTOCKS.length);
    for (const x of TRADABLE_XSTOCKS) assert.match(x.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, x.symbol);
  });

  it("holds the 22 found buyable on 2026-09-25", () => {
    assert.equal(TRADABLE_XSTOCKS.length, 22);
  });
});
