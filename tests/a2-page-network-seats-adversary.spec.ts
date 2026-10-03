/**
 * Adversary on b21087a (pageNetwork follows only routes that exist). Spec (Joshua, 2026-10-03): pageNetwork must
 * agree, for every URL, with what app/src/app renders; a Solana page includes "the circle states and their
 * join/position seats that render a page", and anything that renders the 404 is null.
 *
 * app/src/app/circle/[id]/join/[seat]/page.tsx and position/[seat]/page.tsx accept id "demo" or a CIRCLE_STATES key
 * (not "stale", which only the circle page knows), and any seat with Number.isInteger(Number(seat)) and 1..circle.n
 * (every fixture has n = 5; dynamicParams is not false, so seats outside generateStaticParams still render).
 *
 *   npx mocha --import=tsx tests/a2-page-network-seats-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { CIRCLE_STATES } from "../app/src/fixtures/circles.ts";
import { pageNetwork } from "../app/src/lib/side-rules.ts";

/** The seat pages' own test, copied from join/[seat]/page.tsx and position/[seat]/page.tsx. */
function seatPageRenders(id: string, seat: string): boolean {
  const n = Number(seat);
  if (id === "demo") return Number.isInteger(n) && n >= 1 && n <= 5;
  const circle = (CIRCLE_STATES as Record<string, { n: number } | undefined>)[id];
  return !!circle && Number.isInteger(n) && n >= 1 && n <= circle.n;
}

describe("adversary: pageNetwork on circle seat pages agrees with what the seat page renders", () => {
  it("/circle/stale/join/<seat> and /circle/stale/position/<seat> render the 404, so they are neutral", () => {
    for (const kind of ["join", "position"]) {
      const p = `/circle/stale/${kind}/1`;
      assert.equal(seatPageRenders("stale", "1"), false, `the seat page 404s for ${p}`);
      assert.equal(pageNetwork(p), null, p);
    }
  });

  it("a seat the page accepts through Number() (01, 1.0, +1, 1e0) renders a Solana seat page", () => {
    for (const seat of ["01", "1.0", "+1", "1e0", "0x1"]) {
      const p = `/circle/forming/join/${seat}`;
      assert.equal(seatPageRenders("forming", seat), true, `the seat page renders ${p}`);
      assert.equal(pageNetwork(p), "solana", p);
    }
  });
});
