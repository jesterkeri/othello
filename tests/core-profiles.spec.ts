/** The app's per-profile action lists equal the reference model's (core/actions/<profile>.json). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ACTION_ARGS, InvalidArguments, checkArgs, type Profile } from "../app/src/lib/core/profiles.ts";

describe("core profiles", () => {
  for (const profile of Object.keys(ACTION_ARGS) as Profile[]) {
    it(`${profile}: same actions and argument names as core/actions/${profile}.json`, () => {
      const j = JSON.parse(readFileSync(new URL(`../core/actions/${profile}.json`, import.meta.url), "utf8"));
      assert.equal(j.profile, profile);
      assert.deepEqual(
        Object.fromEntries(Object.entries(ACTION_ARGS[profile]).map(([k, v]) => [k, [...v]])),
        j.actions,
      );
    });
  }

  it("checkArgs wants exact keys", () => {
    assert.doesNotThrow(() => checkArgs("evm-usdg-v1", "topUpReserve", { amount: 1n, expectedFill: 0n }));
    assert.throws(() => checkArgs("evm-usdg-v1", "topUpReserve", { amount: 1n }), InvalidArguments);
    assert.throws(() => checkArgs("solana-pyth-v2", "topUpReserve", { amount: 1n, expectedFill: 0n }), InvalidArguments);
    assert.throws(() => checkArgs("common-v1", "topUpReserve", { amount: 1n }), InvalidArguments);
    assert.throws(() => checkArgs("evm-usdg-v1", "withdraw", { extra: 1 }), InvalidArguments);
  });
});
