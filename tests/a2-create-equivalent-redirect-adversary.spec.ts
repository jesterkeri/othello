/**
 * Adversary pass on 1ea71fe. Spec (Joshua, 2026-10-03): "every Solana route sends the person to the Robinhood Chain
 * equivalent", with "the mirror" for a Solana wallet; the same spec names the create pages of each side: /robinhood/new
 * for Robinhood Chain, /circle/new for Solana. RouteGate (components/othello/SideGate.tsx) decides with
 * gateDecision(sideOf(pathname), labelOf(pathname), connected); this composes the same three functions.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a2-create-equivalent-redirect-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { sideOf } from "../app/src/lib/chains.ts";
import { gateDecision, labelOf, type Connected } from "../app/src/lib/side-rules.ts";

const evm: Connected = { solana: false, robinhood: true };
const sol: Connected = { solana: true, robinhood: false };

const routeGate = (pathname: string, connected: Connected) => gateDecision(sideOf(pathname), labelOf(pathname), connected);

describe("A2 adversary: a create page redirects to the other side's create page", () => {
  it("only an EVM wallet on /circle/new is sent to /robinhood/new", () => {
    assert.deepEqual(routeGate("/circle/new", evm), { show: "redirect", to: "/robinhood/new" });
  });

  it("only a Solana wallet on /robinhood/new is sent to /circle/new", () => {
    assert.deepEqual(routeGate("/robinhood/new", sol), { show: "redirect", to: "/circle/new" });
  });
});
