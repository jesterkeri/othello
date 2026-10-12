/**
 * The landing's Robinhood Chain "Try it on" link reads the trusted factory's first circle (firstCircleWith in
 * app/src/lib/robinhood/adapter-core.ts) instead of shipping a hard-coded address, which the trust gate refuses.
 *
 *   npx mocha --import=tsx tests/robinhood-first-circle.spec.ts
 */
import assert from "node:assert/strict";
import { keccak256, type Address, type Hex } from "viem";

import { firstCircleWith } from "../app/src/lib/robinhood/adapter-core.ts";

const CODE: Hex = "0x6080604052";
const FACTORY = { address: "0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5" as Address, codeHash: keccak256(CODE) };
const FIRST = "0x4bBBf722b8A3D6B5C4497eCD30c34b0FcC9aCd34" as Address;

function client(o: { code?: Hex; count?: bigint }) {
  const calls: string[] = [];
  return {
    calls,
    getCode: async () => o.code ?? CODE,
    readContract: async (r: { functionName: string; args?: readonly unknown[] }) => {
      calls.push(`${r.functionName}(${(r.args ?? []).join(",")})`);
      if (r.functionName === "circleCount") return o.count ?? 1n;
      if (r.functionName === "circles") return FIRST;
      throw new Error(`unexpected ${r.functionName}`);
    },
  };
}

describe("the landing's first Robinhood circle", () => {
  it("is circles(0) of the trusted factory once its code matches the pin", async () => {
    const c = client({});
    assert.equal(await firstCircleWith(c as never, FACTORY), FIRST);
    assert.deepEqual(c.calls, ["circleCount()", "circles(0)"]);
  });

  it("is null with no factory configured, and reads nothing", async () => {
    const c = client({});
    assert.equal(await firstCircleWith(c as never, null), null);
    assert.deepEqual(c.calls, []);
  });

  it("is null when the factory has made no circle (never circles(0), which would revert)", async () => {
    const c = client({ count: 0n });
    assert.equal(await firstCircleWith(c as never, FACTORY), null);
    assert.deepEqual(c.calls, ["circleCount()"]);
  });

  it("fails, and reads no circle, when the factory's live code is not the pinned code", async () => {
    const c = client({ code: "0x6080604053" });
    await assert.rejects(firstCircleWith(c as never, FACTORY), /could not be verified/);
    assert.deepEqual(c.calls, []);
  });
});
