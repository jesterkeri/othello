/**
 * The asset page's decoder (app/src/lib/mintInfo.ts) on the four REAL xStock
 * mints (tests/fixtures, fetched from mainnet at T00 with provenance). Every
 * expected value below was read independently from the same bytes with a
 * separate Python decoder before this test was written.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO } from "./artifacts.ts";
import { REAL_XSTOCKS } from "../app/src/lib/devnet.ts";
import { readMintInfo } from "../app/src/lib/mintInfo.ts";

const bytes = (symbol: string) =>
  Buffer.from((JSON.parse(readFileSync(resolve(REPO, `tests/fixtures/${symbol}.json`), "utf8")) as { dataBase64: string }).dataBase64, "base64");

const NAMES: Record<string, string> = { AAPLx: "Apple xStock", NFLXx: "Netflix xStock", SPYx: "SP500 xStock", NVDAx: "NVIDIA xStock" };

describe("asset page: mintInfo.ts on the real xStocks", () => {
  for (const x of REAL_XSTOCKS) {
    it(`${x.symbol}: the mint's own name and symbol, its authorities and its issuer powers`, () => {
      const m = readMintInfo(bytes(x.symbol));
      assert.deepEqual(
        { name: m.metadata?.name, symbol: m.metadata?.symbol },
        { name: NAMES[x.symbol], symbol: x.symbol },
        "name and symbol from the mint's own TokenMetadata",
      );
      assert.match(m.metadata!.uri, new RegExp(`^https://xstocks-metadata\\.backed\\.fi/tokens/Solana/${x.symbol}/`));
      assert.equal(m.decimals, 8);
      assert.ok(m.mintAuthority?.startsWith("7pt9tkct"), "mint authority set");
      assert.ok(m.freezeAuthority?.startsWith("JDq14BWv"), "freeze authority set");
      assert.ok(m.permanentDelegate?.startsWith("5aMNNLQJ"), "permanent delegate set");
      assert.deepEqual({ paused: m.pausable?.paused, by: m.pausable?.authority?.slice(0, 8) }, { paused: false, by: "JDq14BWv" });
      assert.equal(m.defaultAccountState, "initialized");
      assert.equal(m.transferHook?.program, null, "a transfer hook extension, with no program set");
      assert.equal(m.confidentialTransfers?.autoApprove, false);
      assert.ok(m.scaledUi);
      assert.ok(m.scaledUiAuthority?.startsWith("S7vY"), "who may change the multiplier");
      assert.deepEqual(
        m.extensions.map((e) => e.type),
        [18, 12, 6, 25, 26, 4, 14, 19],
        "the extension list, in the mint's own order",
      );
    });
  }

  it("refuses bytes that are not an initialized Token-2022 mint, rather than guessing", () => {
    assert.throws(() => readMintInfo(Buffer.alloc(82)), /not an initialized mint/);
    const account = bytes("NFLXx");
    account[165] = 2;
    assert.throws(() => readMintInfo(account), /not a Token-2022 mint account/);
    assert.throws(() => readMintInfo(bytes("NFLXx").subarray(0, 300)), /truncated/);
  });
});
