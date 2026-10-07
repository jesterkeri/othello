/**
 * Circle reads one at a time (lib/robinhood/adapter-core.ts readCircleInTurn). Joshua's preview (2026-10-07): the
 * public Robinhood testnet RPC answered two circle reads made together (about 66 calls) with 429 "Too Many Requests"
 * or a short batch, and every circle on the list failed; each read alone succeeds. The list and the portfolio read
 * through this queue, so no two circle reads overlap, and one failure does not stop the next.
 *
 *   npx mocha --import=tsx tests/robinhood-read-in-turn.spec.ts
 */
import assert from "node:assert/strict";

import { readCircleInTurn, StaleRead } from "../app/src/lib/robinhood/adapter-core.ts";

describe("readCircleInTurn: circle reads never overlap", () => {
  it("starts each read only after the one before it has settled, failed reads included", async () => {
    let open = 0;
    let most = 0;
    const order: string[] = [];
    // a client whose first call (getBlock) holds the read open for a moment, then refuses: each read fails after its
    // retries, which is enough to see whether two reads were ever in flight at once
    const client = {
      getBlock: async () => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 5));
        open -= 1;
        throw new Error("refused");
      },
      readContract: async () => { throw new Error("unused"); },
    };
    const reads = ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"].map(
      (a) => readCircleInTurn(client as never, a as `0x${string}`).then(() => order.push(`${a.slice(-1)} ok`), () => order.push(`${a.slice(-1)} failed`)),
    );
    await Promise.all(reads);
    assert.equal(most, 1, "two circle reads were in flight at once");
    assert.deepEqual(order, ["1 failed", "2 failed", "3 failed"], "each read settles in order and a failure does not stop the next");
  });

  it("skips a waiting read whose page has moved on, without touching the RPC", async () => {
    let calls = 0;
    const client = {
      getBlock: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); throw new Error("refused"); },
      readContract: async () => { throw new Error("unused"); },
    };
    let moved = false;
    const first = readCircleInTurn(client as never, "0x0000000000000000000000000000000000000001", () => moved).catch((e) => e);
    const second = readCircleInTurn(client as never, "0x0000000000000000000000000000000000000002", () => moved).catch((e) => e);
    while (calls === 0) await new Promise((r) => setTimeout(r, 1)); // the first read has reached the RPC
    moved = true; // the wallet switched while the first read was running and the second was waiting
    assert.ok(!((await first) instanceof StaleRead), "the read already running finishes as it would");
    assert.ok((await second) instanceof StaleRead, "the waiting read is skipped");
    assert.equal(calls, 3, "only the first read's three tries reached the RPC");
  });

  it("a caller that gives up on its first failure starts no further read (the portfolio's pattern)", async () => {
    const started: string[] = [];
    const client = {
      getBlock: async () => { await new Promise((r) => setTimeout(r, 2)); throw new Error("refused"); },
      readContract: async () => { throw new Error("unused"); },
    };
    let gaveUp = false;
    const addrs = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"];
    // as RobinhoodPortfolio readRunningCircles: each read marks the give-up in its own rejection
    await Promise.all(addrs.map((a) =>
      readCircleInTurn(client as never, a as `0x${string}`, () => { if (!gaveUp) started.push(a.slice(-2)); return gaveUp; })
        .catch((e: unknown) => { gaveUp = true; throw e; }))).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(started, ["a1"], "a read started after the first one failed");
  });
});

