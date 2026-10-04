/**
 * Adversary pass on 0553f0e (A2 spec 3: the landing copy is chain-neutral and true for both sides).
 *
 * Neither side lets a member be defaulted before their turn: the EVM circle reverts PrePayoutDefaultUnsupported
 * (evm/src/OthelloCircle.sol declareDefault) and so does the Solana program (programs/othello/src/instructions/
 * declare_default.rs). So locked assets cover only a member who stops after taking the pot; the Robinhood pages say
 * "after their turn". A landing line saying they pay for "anyone who stops" is false on both sides.
 *
 *   npx mocha --import=tsx tests/a2-landing-anyone-who-stops-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO } from "./artifacts.ts";

const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

describe("A2 copy adversary: who the locked assets pay for (0553f0e)", () => {
  it("the landing does not say locked assets pay for anyone who stops, when neither chain can default before a turn", () => {
    assert.match(read("evm/src/OthelloCircle.sol"), /if \(!_bit\(receivedBitmap, turn\)\) revert PrePayoutDefaultUnsupported\(\);/);
    assert.match(read("programs/othello/src/instructions/declare_default.rs"), /received_bitmap & bit != 0,\s*OthelloError::PrePayoutDefaultUnsupported/);

    const landing = read("app/src/components/landing/Landing.tsx");
    // any "pays for / covers anyone who ... stops" claim, in any wording, must say the cover is after taking the pot
    const claims = [...landing.matchAll(/'([^']*\b(?:pays?(?: for)?|covers?)\s+anyone who\b[^']*\bstops\b[^']*)'/gi)].map((m) => m[1] ?? "");
    assert.ok(claims.length >= 2, `not vacuous: the landing's promise phrase (PHRASES and STEPS) is found: ${JSON.stringify(claims)}`);
    const unqualified = claims.filter((c) => !/after|taken|takes|took|the pot/i.test(c));
    assert.deepEqual(unqualified, [], `landing copy promises cover for a member who stops before their turn: ${JSON.stringify(unqualified)}`);
  });
});
