/**
 * Adversary on 0816b86 (A3: an inner page per testnet Stock Token). Spec (Joshua, 2026-10-04): "Each of the five has
 * its own inner page (/robinhood/assets/<SYMBOL>) ... The page is behind the same wallet gate as the other Robinhood
 * pages", and "Unchanged: everything else on the live site (wallets ...)". The connect window opens at the network
 * lib/side-rules.ts pageNetwork returns (components/othello/WalletConnect.tsx): on a page of one chain, straight at
 * that chain's wallets (Joshua, 2026-10-03); null means the network choice, Solana wallets included, which is for
 * neutral pages and 404s only. The Solana asset page /assets/<xStock> already opens at Solana's wallets
 * (tests/neutral-site.spec.ts); the new Robinhood asset pages must open at Robinhood's, and an unknown symbol (a 404)
 * must stay neutral.
 *
 *   npx mocha --import=tsx tests/a3-asset-page-network-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { sideOf } from "../app/src/lib/chains.ts";
import { pageNetwork } from "../app/src/lib/side-rules.ts";
import { TESTNET_STOCK_TOKENS } from "../app/src/lib/robinhood/testnet-stocks.ts";

describe("adversary: the testnet Stock Token pages open the connect window at Robinhood Chain", () => {
  it("each /robinhood/assets/<SYMBOL> page is Robinhood's for the connect window, as /robinhood/assets is", () => {
    assert.equal(TESTNET_STOCK_TOKENS.length, 5, "not vacuous");
    assert.equal(pageNetwork("/robinhood/assets"), "robinhood");
    for (const t of TESTNET_STOCK_TOKENS) {
      const p = `/robinhood/assets/${t.symbol}`;
      // the gate (components/othello/SideGate.tsx RouteGate) already treats it as a Robinhood page
      assert.equal(sideOf(p), "robinhood", `sideOf ${p}`);
      assert.equal(pageNetwork(p), "robinhood", `pageNetwork ${p}`);
    }
  });

  it("a symbol with no page (the 404) still starts at the network choice", () => {
    for (const p of ["/robinhood/assets/AAPL", "/robinhood/assets/tsla", "/robinhood/assets/TSLA/x"]) {
      assert.equal(pageNetwork(p), null, p);
    }
  });
});
