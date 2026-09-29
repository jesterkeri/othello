/**
 * The "My circles" list state (app/src/lib/robinhood/my-circles.ts): paging, retry and the stale-error case from
 * Codex code review r3 m1 (an error must not stay on screen after a later success).
 *
 *   npx mocha --import=tsx tests/robinhood-my-circles.spec.ts
 */
import assert from "node:assert/strict";

import type { CircleSummary } from "../app/src/lib/robinhood/adapter-core.ts";
import { EMPTY, hasMore, myCircles, nextBefore, type MyCircles, type MyCirclesAction } from "../app/src/lib/robinhood/my-circles.ts";

const circle = (i: number): CircleSummary => ({
  address: `0x${i.toString(16).padStart(40, "0")}`, n: 3, c: 1_000_000n, status: "Forming", round: 0,
  creator: "0x0000000000000000000000000000000000000001", turn: 0,
});
const run = (...as: MyCirclesAction[]): MyCircles => as.reduce(myCircles, EMPTY);

describe("My circles list state", () => {
  it("before the first page: loading, nothing to show, first request asks for the newest page", () => {
    const s = run({ type: "start" });
    assert.equal(s.loading, true);
    assert.equal(s.started, false);
    assert.equal(nextBefore(s), undefined);
    assert.equal(hasMore(s), false);
  });

  it("an error followed by a success leaves no error shown (r3 m1)", () => {
    const failed = run({ type: "start" }, { type: "fail", message: "HTTP request failed" });
    assert.equal(failed.error, "HTTP request failed");
    assert.equal(nextBefore(failed), undefined, "retry asks for the same (first) page");
    const retried = myCircles(failed, { type: "start" });
    assert.equal(retried.error, null, "a new request clears the old error at once");
    const ok = myCircles(retried, { type: "page", page: { circles: [circle(1)], total: 1, before: null } });
    assert.equal(ok.error, null);
    assert.equal(ok.circles.length, 1);
  });

  it("a success after an error with no new start still clears the error", () => {
    const s = run({ type: "start" }, { type: "fail", message: "x" }, { type: "page", page: { circles: [], total: 0, before: null } });
    assert.equal(s.error, null);
    assert.equal(s.started, true);
  });

  it("Show more continues below the last page, appends, and stops at the oldest", () => {
    const p1 = run({ type: "start" }, { type: "page", page: { circles: [circle(25), circle(24)], total: 25, before: 15 } });
    assert.equal(hasMore(p1), true);
    assert.equal(nextBefore(p1), 15);
    const p2 = myCircles(myCircles(p1, { type: "start" }), { type: "page", page: { circles: [circle(14), circle(13)], total: 26, before: 5 } });
    assert.deepEqual(p2.circles.map((c) => c.address), [circle(25), circle(24), circle(14), circle(13)].map((c) => c.address));
    assert.equal(nextBefore(p2), 5);
    const p3 = myCircles(myCircles(p2, { type: "start" }), { type: "page", page: { circles: [circle(4)], total: 26, before: null } });
    assert.equal(hasMore(p3), false);
    assert.equal(p3.circles.length, 5);
  });

  it("a failed Show more keeps the circles already shown and retries the same page", () => {
    const p1 = run({ type: "start" }, { type: "page", page: { circles: [circle(9)], total: 20, before: 10 } });
    const failed = myCircles(myCircles(p1, { type: "start" }), { type: "fail", message: "timeout" });
    assert.equal(failed.circles.length, 1);
    assert.equal(nextBefore(failed), 10);
    assert.equal(failed.loading, false);
  });

  it("the same circle arriving twice is shown once", () => {
    const s = run(
      { type: "page", page: { circles: [circle(3)], total: 3, before: 2 } },
      { type: "page", page: { circles: [circle(3), circle(2)], total: 3, before: null } },
    );
    assert.deepEqual(s.circles.map((c) => c.address), [circle(3).address, circle(2).address]);
  });

  it("reset (another wallet) forgets everything", () => {
    const s = run({ type: "page", page: { circles: [circle(1)], total: 1, before: null } }, { type: "fail", message: "x" }, { type: "reset" });
    assert.deepEqual(s, EMPTY);
  });
});
