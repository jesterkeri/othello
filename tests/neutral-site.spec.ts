/**
 * The connected wallet decides what the site shows (Joshua, 2026-10-03): app/src/lib/side-rules.ts and lib/nav.ts.
 * No wallet: neutral, both chains offered, chain pages ask for a wallet. One wallet: only that chain anywhere (a judge
 * with MetaMask never reaches a Solana page). Both: the page's own side, with the switch to move.
 *
 *   npx mocha --import=tsx tests/neutral-site.spec.ts
 */
import assert from "node:assert/strict";

import { hrefFor } from "../app/src/lib/nav.ts";
import { activeSide, gateDecision, labelOf, showsChainSwitch } from "../app/src/lib/side-rules.ts";

const none = { solana: false, robinhood: false };
const evm = { solana: false, robinhood: true };
const sol = { solana: true, robinhood: false };
const both = { solana: true, robinhood: true };

describe("neutral site: the connected wallet decides the side", () => {
  it("the active side is the only connected wallet's, the page's with both, and none with no wallet", () => {
    for (const route of ["solana", "robinhood"] as const) {
      assert.equal(activeSide(none, route), null);
      assert.equal(activeSide(evm, route), "robinhood", `an EVM wallet shows Robinhood Chain even on a ${route} route`);
      assert.equal(activeSide(sol, route), "solana");
      assert.equal(activeSide(both, route), route);
    }
  });

  it("the chain switch shows only with no wallet or both", () => {
    assert.equal(showsChainSwitch(none), true);
    assert.equal(showsChainSwitch(both), true);
    assert.equal(showsChainSwitch(evm), false, "with only MetaMask, no Solana link in the frame");
    assert.equal(showsChainSwitch(sol), false);
  });

  it("menu links: neutral with no wallet, that chain's pages with one", () => {
    for (const label of ["Circles", "Portfolio", "Assets"]) {
      const neutral = hrefFor(label, null);
      const rh = hrefFor(label, "robinhood");
      const so = hrefFor(label, "solana");
      assert.ok(rh === "/robinhood" || rh.startsWith("/robinhood/"), `${label} with an EVM wallet goes to a Robinhood Chain page, not ${rh}`);
      assert.ok(!(so === "/robinhood" || so.startsWith("/robinhood/")), `${label} with a Solana wallet stays on Solana pages, not ${so}`);
      assert.notEqual(neutral, rh);
    }
    assert.equal(hrefFor("Circles", null), "/circles", "no wallet: the neutral circles entry, which asks for a wallet");
    assert.equal(hrefFor("Assets", "robinhood"), "/robinhood/assets");
    assert.equal(hrefFor("Home", "robinhood"), "/");
    assert.equal(hrefFor("How it works", "solana"), "/how-it-works");
  });

  it("a chain's page: shown with its wallet, sent to the other side's page with only the other wallet, else a gate", () => {
    assert.deepEqual(gateDecision("solana", "Assets", none), { show: "connect" });
    assert.deepEqual(gateDecision("solana", "Assets", sol), { show: "page" });
    assert.deepEqual(gateDecision("solana", "Assets", both), { show: "page" });
    assert.deepEqual(gateDecision("solana", "Assets", evm), { show: "redirect", to: "/robinhood/assets" });
    assert.deepEqual(gateDecision("solana", "Portfolio", evm), { show: "redirect", to: "/robinhood" });
    assert.deepEqual(gateDecision("solana", "Circles", evm), { show: "redirect", to: "/robinhood" });
    assert.deepEqual(gateDecision("robinhood", "Circles", sol), { show: "redirect", to: "/circle/demo" });
    assert.deepEqual(gateDecision("robinhood", "Assets", sol), { show: "redirect", to: "/assets" });
    assert.deepEqual(gateDecision("robinhood", "Circles", none), { show: "connect" });
    assert.deepEqual(gateDecision("robinhood", "Circles", evm), { show: "page" });
  });

  it("each gated route belongs to the right menu label", () => {
    assert.equal(labelOf("/assets"), "Assets");
    assert.equal(labelOf("/assets/TSLAx"), "Assets");
    assert.equal(labelOf("/robinhood/assets"), "Assets");
    assert.equal(labelOf("/portfolio"), "Portfolio");
    assert.equal(labelOf("/robinhood"), "Circles");
    assert.equal(labelOf("/robinhood/new"), "Circles");
    assert.equal(labelOf("/circle/demo"), "Circles");
    assert.equal(labelOf("/circle/rh:0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5"), "Circles");
    assert.equal(labelOf("/assetsx"), "Circles", "only the assets routes themselves");
  });
});
