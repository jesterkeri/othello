import assert from "node:assert/strict";

import { reserveDisplay } from "../app/src/lib/robinhood/reserve-display.ts";

const units = 1_000_000n;

describe("A4 Robinhood circle reserve display", () => {
  it("never labels reserve allocated to unpaid obligations as free", () => {
    const card = reserveDisplay({
      status: "Active",
      reserveTotal: 10n * units,
      reserveLosses: 2n * units,
      reserveAllocated: 3n * units,
      escrow: 0n,
      withdrawnFromReserve: 0n,
      nextGateShortBy: 0n,
    });
    assert.equal(card.heading, "Shared reserve, free");
    assert.equal(card.amount, 5n * units);
    assert.deepEqual(card.lines.at(-2), ["=", "Free reserve", 5n * units]);
  });

  it("shows the actual remaining withdrawal pool after completion", () => {
    const card = reserveDisplay({
      status: "Completed",
      reserveTotal: 10n * units,
      reserveLosses: 2n * units,
      reserveAllocated: 8n * units,
      escrow: 4n * units,
      withdrawnFromReserve: 3n * units,
      nextGateShortBy: 0n,
    });
    assert.equal(card.heading, "Shared reserve to withdraw");
    assert.equal(card.amount, 9n * units);
    assert.deepEqual(card.lines.at(-1), ["=", "Still available to withdraw", 9n * units]);
  });
});
