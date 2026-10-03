/**
 * Adversary on b47a8ac (connect window: network first). pageNetwork (lib/side-rules.ts) decides which network's
 * wallets the window opens at; lib/chains.ts sideOf is the site's own rule for which chain a path belongs to, and
 * matches the circle page (app/src/app/circle/[id]/page.tsx decodes the segment Next already decoded once, then
 * tests startsWith("rh:")). Spec (Joshua, 2026-10-03): "a Robinhood page shows nothing of Solana in the window".
 *
 *   npx mocha --import=tsx tests/a2-page-network-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { sideOf } from "../app/src/lib/chains.ts";
import { pageNetwork } from "../app/src/lib/side-rules.ts";

const ADDR = "0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5";

describe("adversary: pageNetwork agrees with sideOf on Robinhood circle pages", () => {
  it("an encoded Robinhood circle URL, which the circle page renders as RobinhoodCircle, opens at Robinhood wallets", () => {
    for (const p of [`/circle/rh%3A${ADDR}`, `/circle/rh%3a${ADDR}`, `/circle/%72h:${ADDR}`, `/circle/rh%253A${ADDR}`]) {
      assert.equal(sideOf(p), "robinhood", `sideOf ${p}`);
      assert.equal(pageNetwork(p), "robinhood", `pageNetwork ${p}`);
    }
  });

  // Spec: "on neutral pages (home, How it works, /circles, unknown routes) it starts at the network choice". These
  // render app/src/app/not-found.tsx (the circle page calls notFound() for an unknown state; no route matches the rest).
  it("an unknown route under a chain's prefix (the 404 page) starts at the network choice", () => {
    for (const p of ["/circle/no-such-state", "/robinhood/no-such-page", "/portfolio/x"]) {
      assert.equal(pageNetwork(p), null, p);
    }
  });
});
