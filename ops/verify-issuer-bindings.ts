/**
 * Verify the issuer's binding of each xStock symbol to its mint address, and record
 * the evidence in ops/issuer-bindings.json.
 *
 * This is where the dependency on Backed's website lives, deliberately and on its
 * own, so a fixture fetch does not die when that site blips. The binding is a
 * property of the (symbol, address) pair and does not change between runs, so
 * checking it live on every fetch bought nothing and cost a 50% failure rate.
 *
 * An address can still never enter the allowlist without a real live verification:
 * fetch-fixtures.ts refuses any mint with no record here, and still hard-fails when
 * the page is reachable and disagrees.
 *
 * Usage: pnpm tsx ops/verify-issuer-bindings.ts
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFIED_XSTOCK_MINTS } from "./xstock-mints.ts";
import { BACKED_ORIGIN, BACKED_NETWORK_ATTR, productPageUrl, fetchOrExplain } from "./issuer.ts";

// Beside this module, so the verifier works from any working directory.
const OUT = join(dirname(fileURLToPath(import.meta.url)), "issuer-bindings.json");

async function main() {
  const records: Record<string, unknown> = {};
  const failures: string[] = [];

  for (const mint of VERIFIED_XSTOCK_MINTS) {
    const url = productPageUrl(mint.productSlug);
    try {
      const res = await fetchOrExplain(url, { redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`redirected (${res.status} to ${res.headers.get("location") ?? "unknown"})`);
      }
      if (!res.ok) throw new Error(`returned ${res.status} ${res.statusText}`);
      const html = await res.text();
      const attr = `${BACKED_NETWORK_ATTR}="${mint.address}"`;
      if (!html.includes(attr)) {
        throw new Error(`does not state ${attr}; the issuer does not bind this address to ${mint.symbol}`);
      }
      records[mint.symbol] = {
        symbol: mint.symbol,
        address: mint.address,
        url,
        attribute: attr,
        bodySha256: createHash("sha256").update(html).digest("hex"),
        verifiedAt: new Date().toISOString(),
      };
      console.log(`${mint.symbol.padEnd(6)} bound by ${url}`);
    } catch (err) {
      failures.push(`${mint.symbol}: ${url} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    console.error("FAILURES:");
    for (const f of failures) console.error(`  ${f}`);
    console.error("\nops/issuer-bindings.json unchanged.");
    process.exit(1);
  }
  writeFileSync(OUT, JSON.stringify({ origin: BACKED_ORIGIN, bindings: records }, null, 2) + "\n");
  console.log(`\nrecorded ${Object.keys(records).length} bindings in ops/issuer-bindings.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
