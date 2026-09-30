/**
 * The route decides the chain side, and connecting a wallet takes the person to that wallet's side (A2-SWITCH).
 *
 *   npx mocha --import=tsx tests/chain-switch.spec.ts
 */
import assert from "node:assert/strict";

import { SIDE_HOME, destinationAfterConnect, sideName, sideOf } from "../app/src/lib/chains.ts";

describe("chain side from the route", () => {
  it("Robinhood Chain pages are /robinhood and below, and a Robinhood circle's page", () => {
    for (const p of ["/robinhood", "/robinhood/", "/robinhood/new", "/circle/rh:0xB1eDe3F5AC8654124Cb5124aDf0Fd3885CbDD1F7", "/circle/rh%3A0xabc", "/circle/RH:0xabc"]) {
      assert.equal(sideOf(p), "robinhood", p);
    }
  });

  it("everything else is the Solana side, including look-alike paths", () => {
    for (const p of ["/", "", null, undefined, "/assets", "/assets/NFLXx", "/circle/demo", "/circle/new", "/circle/rhino", "/robinhoodx", "/how-it-works", "/split-lab", "/portfolio"]) {
      assert.equal(sideOf(p), "solana", String(p));
    }
  });

  it("the homes the switch links to", () => {
    assert.deepEqual(SIDE_HOME, { solana: "/", robinhood: "/robinhood" });
    assert.equal(sideOf(SIDE_HOME.solana), "solana");
    assert.equal(sideOf(SIDE_HOME.robinhood), "robinhood");
  });

  it("the switch names both networks, since both are test networks", () => {
    assert.equal(sideName("solana"), "Solana devnet");
    assert.equal(sideName("robinhood"), "Robinhood Chain testnet");
  });

  it("connecting a wallet goes to that wallet's side, or stays when already there", () => {
    assert.equal(destinationAfterConnect("robinhood", "/"), "/robinhood");
    assert.equal(destinationAfterConnect("robinhood", "/circle/demo"), "/robinhood");
    assert.equal(destinationAfterConnect("robinhood", "/robinhood/new"), null);
    assert.equal(destinationAfterConnect("robinhood", "/circle/rh:0xabc"), null);
    assert.equal(destinationAfterConnect("solana", "/robinhood"), "/");
    assert.equal(destinationAfterConnect("solana", "/circle/rh:0xabc"), "/");
    assert.equal(destinationAfterConnect("solana", "/assets"), null);
    assert.equal(destinationAfterConnect("solana", "/"), null);
  });
});
