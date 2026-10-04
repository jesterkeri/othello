/**
 * The connected wallet decides what the site shows (Joshua, 2026-10-03): app/src/lib/side-rules.ts and lib/nav.ts.
 * No wallet: neutral, both chains offered, chain pages ask for a wallet. One wallet: only that chain anywhere (a judge
 * with MetaMask never reaches a Solana page). Both: the page's own side, with the switch to move.
 *
 *   npx mocha --import=tsx tests/neutral-site.spec.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hrefFor } from "../app/src/lib/nav.ts";
import { activeSide, gateDecision, labelOf, pageNetwork, showsChainSwitch } from "../app/src/lib/side-rules.ts";

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
    assert.equal(labelOf("/circle/demo"), "Circles");
    assert.equal(labelOf("/circle/rh:0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5"), "Circles");
    assert.equal(labelOf("/assetsx"), "Circles", "only the assets routes themselves");
    assert.equal(labelOf("/circle/new"), "Create");
    assert.equal(labelOf("/robinhood/new"), "Create");
    assert.deepEqual(gateDecision("solana", "Create", { solana: false, robinhood: true }), { show: "redirect", to: "/robinhood/new" });
    assert.deepEqual(gateDecision("robinhood", "Create", { solana: true, robinhood: false }), { show: "redirect", to: "/circle/new" });
  });

  it("every route folder is gated by its layout, except the neutral ones (adversary pass on 8e93a30: /split-lab was not)", () => {
    const appDir = fileURLToPath(new URL("../app/src/app/", import.meta.url));
    // neutral for everyone: the circles entry, How it works (it picks its content by side), and the API
    const NEUTRAL = new Set(["circles", "how-it-works", "api"]);
    const routes = readdirSync(appDir).filter((d) => statSync(join(appDir, d)).isDirectory());
    assert.ok(routes.includes("assets") && routes.includes("robinhood"), `not vacuous: found ${routes.join(", ")}`);
    const ungated = routes.filter((d) => !NEUTRAL.has(d)).filter((d) => {
      const layout = join(appDir, d, "layout.tsx");
      // the gate must be what the layout returns, not a mention in a comment. Stated limit (adversary on 856f0d8): this
      // catches a forgotten gate, not one written to deceive (a matching line in a block comment or an unused helper);
      // every layout is reviewed
      return !existsSync(layout) || !/^\s*return <RouteGate>\{children\}<\/RouteGate>;\s*$/m.test(readFileSync(layout, "utf8"));
    });
    assert.deepEqual(ungated, [], `route folders with no RouteGate layout: ${ungated.join(", ")}`);
  });

  it("the connect window opens at a chain page's network and asks for the network on neutral pages (Joshua, 2026-10-03)", () => {
    for (const p of ["/robinhood", "/robinhood/new", "/robinhood/assets", "/circle/rh:0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5",
      "/circle/rh%3A0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5"]) {
      assert.equal(pageNetwork(p), "robinhood", p);
    }
    for (const p of ["/assets", "/assets/TSLAx", "/portfolio", "/circle/demo", "/circle/new", "/circle/forming/join/2", "/split-lab"]) {
      assert.equal(pageNetwork(p), "solana", p);
    }
    for (const p of ["/", "/how-it-works", "/circles", "/no-such-page", "/robinhoodx", "/assetsx", "", null, undefined,
      "/circle/no-such-state", "/robinhood/no-such-page", "/portfolio/x", "/assets/NOTASTOCK", "/circle/demo/join/9"]) {
      assert.equal(pageNetwork(p as string), null, String(p));
    }
  });
});

