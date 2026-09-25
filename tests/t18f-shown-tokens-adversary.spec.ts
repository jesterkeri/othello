/**
 * T18f adversary: lib/format.ts shownTokens, the Portfolio row's "= what your wallet shows".
 *
 * Requirements under test:
 * - T18f brief item 1/2: no made-up number on /portfolio; balances exact, no JS Number rounding.
 * - SPEC.md I5 (SPEC.md:189): "mult_fixed = floor(true_value x 1e9) exactly; vectors 1002664207,
 *   1003269012". shownTokens' own header says the multiplier is "at 9 decimals (the program's
 *   fixed point, SPEC §4) and floored".
 * - AGENTS.md money maths: "collateral rounds down".
 * So the figure may truncate the true raw x multiplier, but must never exceed it: a holder must
 * never be shown more stock than the mint says they hold.
 *
 * Multiplier: AAPLx's real mint account, tests/fixtures/AAPLx.json (mainnet, T00 provenance),
 * decoded with the app's own readScaledUi. Its multiplier is 1.0026642075893797 (the I5 vector
 * 1002664207 is its floor).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO } from "./artifacts.ts";
import { exactTokens, shownTokens } from "../app/src/lib/format.ts";
import { readScaledUi } from "../app/src/lib/scaledUi.ts";

const fx = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/AAPLx.json"), "utf8")) as { dataBase64: string; decimals: number };
const ui = readScaledUi(new Uint8Array(Buffer.from(fx.dataBase64, "base64")));

/** The f64 multiplier as an exact fraction num / 2^exp (every finite f64 is one). */
function exactF64(x: number): { num: bigint; den: bigint } {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  const bits = b.getBigUint64(0);
  const e = Number((bits >> 52n) & 0x7ffn);
  const mant = (bits & ((1n << 52n) - 1n)) | (e ? 1n << 52n : 0n);
  const shift = BigInt(e ? e - 1075 : -1074);
  return shift >= 0n ? { num: mant << shift, den: 1n } : { num: mant, den: 1n << -shift };
}

describe("T18f adversary: shownTokens never shows more than raw x the mint's multiplier", () => {
  it("reads AAPLx's real multiplier from the fixture", () => {
    assert.ok(ui, "AAPLx fixture carries a ScaledUiAmount extension");
    assert.equal(ui.multiplier, 1.0026642075893797);
  });

  for (const raw of ["10000000000", "9007199254740993"]) {
    it(`raw ${raw} (AAPLx, 8 dp): the shown amount is at most floor(raw x multiplier)`, () => {
      const m = exactF64(ui!.multiplier);
      const trueRaw = (BigInt(raw) * m.num) / m.den; // floor of the exact product
      const i5Raw = (BigInt(raw) * 1_002_664_207n) / 1_000_000_000n; // I5's fixed point, floored
      const shown = shownTokens(raw, fx.decimals, ui!.multiplier);
      const shownRaw = BigInt(shown.replace(/[.,]/g, ""));
      assert.ok(
        shownRaw <= trueRaw,
        `shows ${shown} AAPLx, but raw x multiplier is ${exactTokens(trueRaw.toString(), fx.decimals)} ` +
          `(I5 fixed point gives ${exactTokens(i5Raw.toString(), fx.decimals)})`,
      );
    });
  }
});
