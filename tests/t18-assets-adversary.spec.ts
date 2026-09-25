/**
 * T18 adversary: the asset page's "What the issuer can do" table against the
 * mint's own bytes, for the one issuer power whose answer does not read the
 * authority that holds it.
 *
 * Requirement under test (T18 asset pages brief): "Every issuer power
 * statement must be TRUE of the decoded bytes". Token-2022's
 * ScaledUiAmountConfig is { authority: OptionalNonZeroPubkey, multiplier,
 * new_multiplier_effective_timestamp, new_multiplier }, and its authority is
 * "Authority that can set the scaling amount and authority"
 * (spl-token-2022-interface-2.1.0 src/extension/scaled_ui_amount/mod.rs:47).
 * It is Optional: Initialize accepts None, and SetAuthority with
 * AuthorityType::ScaledUiAmount (src/instruction.rs:1154) can revoke it, which
 * writes 32 zero bytes. With no authority nobody can call UpdateMultiplier, so
 * "the issuer can change the multiplier" is false of those bytes.
 *
 * Bytes: tests/fixtures/NFLXx.json, the real mainnet mint (slot 449,145,146,
 * T00 provenance). The "revoked" mint is the same bytes with only the
 * ScaledUiAmountConfig authority zeroed, exactly what that SetAuthority
 * writes. Everything else, every other authority included, is unchanged.
 *
 * Path: bytes -> app/src/app/api/live/route.ts GET (global fetch stubbed to
 * answer getMultipleAccounts with the fixture accounts) -> its JSON body ->
 * app/src/components/assets/AssetDetail.tsx rendered with react-dom/server.
 * The only substitutions are the ones a server render needs: CSS modules
 * become class-name stubs, and useLiveXStocks (a useEffect fetch, which a
 * server render never runs) returns the route's own body.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { REAL_XSTOCKS } from "../app/src/lib/devnet.ts";

const SRC = resolve(REPO, "app/src");
const HOOK = resolve(SRC, "components/assets/useLiveXStocks.ts");
const SCALED_UI_AMOUNT = 25;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      return {
        url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    if (specifier === "./useLiveXStocks" && context.parentURL?.includes("/components/assets/")) {
      const real = `${pathToFileURL(HOOK).href}?real`;
      const stub =
        `import * as real from ${JSON.stringify(real)};` +
        "export const mult = real.mult, tokens = real.tokens, when = real.when;" +
        "export function useLiveXStocks() { return { data: globalThis.__othelloLive, error: null }; }";
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const fixture = (symbol: string) =>
  JSON.parse(readFileSync(resolve(REPO, `tests/fixtures/${symbol}.json`), "utf8")) as { address: string; dataBase64: string };

/** The real bytes with ScaledUiAmountConfig's authority set to None (32 zero bytes), nothing else touched. */
function withScaledUiAuthorityRevoked(data: Buffer): Buffer {
  const out = Buffer.from(data);
  let off = 166;
  while (off + 4 <= out.length) {
    const type = out.readUInt16LE(off);
    const len = out.readUInt16LE(off + 2);
    if (type === 0) break;
    if (type === SCALED_UI_AMOUNT) {
      assert.ok(out.subarray(off + 4, off + 36).some((b) => b !== 0), "the real NFLXx has a scaled UI authority to revoke");
      out.fill(0, off + 4, off + 36);
      return out;
    }
    off += 4 + len;
  }
  throw new Error("NFLXx fixture carries no ScaledUiAmountConfig");
}

/** /api/live's body, from the route itself, with mainnet answering these bytes. */
async function liveBody(nflxx: Buffer): Promise<unknown> {
  const route = await import(pathToFileURL(resolve(SRC, "app/api/live/route.ts")).href + `?t=${Math.random()}`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 449_145_146 },
          value: REAL_XSTOCKS.map((x) => ({
            owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            data: [(x.symbol === "NFLXx" ? nflxx : Buffer.from(fixture(x.symbol).dataBase64, "base64")).toString("base64"), "base64"],
          })),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const res = await route.GET();
    assert.equal(res.status, 200, "the route reads the bytes");
    return res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The answer cell of one row of "What the issuer can do", as text. */
async function answer(nflxx: Buffer, label: string): Promise<string> {
  (globalThis as { __othelloLive?: unknown }).__othelloLive = await liveBody(nflxx);
  const req = createRequire(resolve(SRC, "components/assets/AssetDetail.tsx"));
  const React = req("react");
  const { renderToStaticMarkup } = req("react-dom/server");
  (globalThis as { React?: unknown }).React = React;
  const { default: AssetDetail } = await import(pathToFileURL(resolve(SRC, "components/assets/AssetDetail.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(AssetDetail, { symbol: "NFLXx" }));
  const row = html.split("<tr>").find((r) => r.includes(`<span>${label}</span>`));
  assert.ok(row, `the page has a "${label}" row`);
  return row.split("<td>")[2]!.split("</td>")[0]!.replace(/<[^>]+>/g, "").trim();
}

describe("T18 adversary: asset page issuer powers are true of the bytes", () => {
  const LABEL = "Change the multiplier (splits, dividends)";
  const real = Buffer.from(fixture("NFLXx").dataBase64, "base64");

  it("does not say the issuer can change the multiplier when the mint's scaled UI authority is None", async () => {
    const withAuthority = await answer(real, LABEL);
    const revoked = await answer(withScaledUiAuthorityRevoked(real), LABEL);

    assert.notEqual(revoked, "Yes", `nobody can call UpdateMultiplier on a ScaledUiAmountConfig whose authority is None, yet the page answers "${revoked}" (with the authority: "${withAuthority}")`);
    assert.notEqual(revoked, withAuthority, "a mint whose multiplier authority is revoked answers differently from one that has it");
  });
});
