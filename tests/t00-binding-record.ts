/**
 * T00 unit test: every field of a recorded issuer binding is validated before it is
 * relied on. An earlier version checked only the address and url, so a record could
 * carry a wrong attribute, a decorative digest or an unbounded age and still be used
 * to mint fixtures during an issuer outage.
 *
 * Run: pnpm tsx tests/t00-binding-record.ts
 */
import { validateBindingRecord, BINDING_MAX_AGE_DAYS } from "../ops/issuer.ts";

const SYMBOL = "SPYx";
const ADDRESS = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const URL_ = `https://assets.backed.fi/products/sp500-xstock`;
const good = {
  symbol: SYMBOL,
  address: ADDRESS,
  url: URL_,
  attribute: `data-network-address="${ADDRESS}"`,
  bodySha256: "a".repeat(64),
  verifiedAt: new Date().toISOString(),
};

const cases: { name: string; record: unknown; expect: string | null }[] = [
  { name: "a complete, fresh record", record: good, expect: null },
  { name: "no record at all", record: undefined, expect: "is missing" },
  { name: "record for another symbol", record: { ...good, symbol: "NVDAx" }, expect: "names symbol" },
  { name: "record for another address", record: { ...good, address: "X".repeat(43) }, expect: "is for" },
  { name: "record for another url", record: { ...good, url: "https://assets.backed.fi/products/other" }, expect: "is not" },
  {
    name: "attribute does not match the address",
    record: { ...good, attribute: 'data-network-address="something-else"' },
    expect: "attribute",
  },
  { name: "digest is not a sha-256", record: { ...good, bodySha256: "nope" }, expect: "bodySha256" },
  { name: "verifiedAt is not a date", record: { ...good, verifiedAt: "yesterday" }, expect: "is not a date" },
  {
    name: "record is older than the age limit",
    record: {
      ...good,
      verifiedAt: new Date(Date.now() - (BINDING_MAX_AGE_DAYS + 1) * 86_400_000).toISOString(),
    },
    expect: "older than the",
  },
];

const failures: string[] = [];
for (const c of cases) {
  let msg: string | null = null;
  try {
    validateBindingRecord(SYMBOL, ADDRESS, URL_, c.record);
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  if (c.expect === null && msg !== null) failures.push(`${c.name}: expected acceptance, got "${msg}"`);
  if (c.expect !== null && msg === null) failures.push(`${c.name}: expected rejection, was accepted`);
  if (c.expect !== null && msg !== null && !msg.includes(c.expect)) {
    failures.push(`${c.name}: rejected for the wrong reason, expected "${c.expect}", got "${msg}"`);
  }
}

if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`OK: ${cases.length} binding-record cases, every field is load-bearing`);
