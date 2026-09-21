/**
 * T00: fetch real xStock mint accounts from Solana mainnet into tests/fixtures.
 *
 * Every byte in a fixture comes from mainnet. No invented stock data (ADR-012).
 * The base64 account data is the authoritative record; the decoded fields are a
 * convenience for readers and are re-derived from those bytes by the program's
 * own decoder in T02 and T03.
 *
 * Usage: pnpm tsx ops/fetch-fixtures.ts
 *        SOLANA_RPC_URL=<url> pnpm tsx ops/fetch-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  VERIFIED_XSTOCK_MINTS,
  MINTS_AWAITING_ADDRESS,
  REQUIRED_FIXTURE_SYMBOLS,
} from "./xstock-mints.ts";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OUT_DIR = join(process.cwd(), "tests", "fixtures");
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Token-2022 mint layout: the base mint is 82 bytes, then one account-type byte,
// then TLV extension entries.
const MINT_BASE_LEN = 82;
const DECIMALS_OFFSET = 44;
const ACCOUNT_TYPE_OFFSET = 165;

// TLV extension discriminants.
const EXT_TOKEN_METADATA = 19;
const EXT_SCALED_UI_AMOUNT = 25;

// ScaledUiAmountConfig, 56 bytes: authority(32) multiplier(8)
// newMultiplierEffectiveTimestamp(8) newMultiplier(8).
const SCALED_UI_AMOUNT_LEN = 56;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Encode 32 raw bytes as base58, to compare a pubkey found in account data with an address. */
function toBase58(bytes: Buffer): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = BASE58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/**
 * The values SPEC 9b.1 records, verified live 2026-09-21. NFLXx is a historical
 * split and cannot move. AAPLx accrues, so if it has moved, SPEC 9b.1 and the G1
 * vectors in SPEC section 10 are stale. That is a design decision for the design
 * session, not something the build absorbs quietly, so it stops and says so.
 */
const SPEC_RECORDED: Record<string, { multiplier: number; newMultiplier: number; ts: string }> = {
  AAPLx: { multiplier: 1.0026642075893797, newMultiplier: 1.0032690125398187, ts: "1786149000" },
  NFLXx: { multiplier: 1, newMultiplier: 10, ts: "1763337300" },
};

type TokenMetadata = { name: string; symbol: string; mint: string };

type ScaledUiAmountConfig = {
  multiplier: number;
  newMultiplierEffectiveTimestamp: string;
  newMultiplier: number;
};

async function getAccountInfo(address: string) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64", commitment: "finalized" }],
    }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${res.status} ${res.statusText} for ${address}`);
  }
  const body = (await res.json()) as any;
  if (body.error) {
    throw new Error(`RPC error for ${address}: ${JSON.stringify(body.error)}`);
  }
  if (!body.result?.value) {
    throw new Error(`account not found on mainnet: ${address}`);
  }
  return { value: body.result.value, slot: body.result.context.slot as number };
}

/** Walk the TLV entries after the account-type byte, returning one extension's value slice. */
function findExtension(data: Buffer, wanted: number): Buffer | null {
  if (data.length <= ACCOUNT_TYPE_OFFSET) return null;
  let off = ACCOUNT_TYPE_OFFSET + 1;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    const start = off + 4;
    if (start + len > data.length) return null;
    if (type === wanted) return data.subarray(start, start + len);
    off = start + len;
  }
  return null;
}

function decodeScaledUiAmountConfig(data: Buffer): ScaledUiAmountConfig {
  const ext = findExtension(data, EXT_SCALED_UI_AMOUNT);
  if (!ext) throw new Error("ScaledUiAmountConfig extension absent");
  if (ext.length < SCALED_UI_AMOUNT_LEN) {
    throw new Error(`ScaledUiAmountConfig too short: ${ext.length} bytes`);
  }
  return {
    multiplier: ext.readDoubleLE(32),
    newMultiplierEffectiveTimestamp: ext.readBigInt64LE(40).toString(),
    newMultiplier: ext.readDoubleLE(48),
  };
}

/**
 * Read name, symbol and the mint pubkey from the mint's own TokenMetadata
 * extension. A symbol from a token list proves nothing: Jupiter returns five
 * tokens named NFLXx and one is real (SPEC 9b.3). This reads what the mint
 * itself carries.
 *
 * Returns null only when the extension is absent. A present but malformed
 * extension throws: swallowing that into null would let an issuer disable the
 * only identity check by corrupting a length prefix.
 */
function decodeTokenMetadata(data: Buffer): TokenMetadata | null {
  const ext = findExtension(data, EXT_TOKEN_METADATA);
  if (!ext) return null;
  if (ext.length < 64) {
    throw new Error(`TokenMetadata is ${ext.length} bytes, too short to hold its own mint pubkey`);
  }
  const mint = toBase58(ext.subarray(32, 64));
  let off = 64; // update_authority(32) + mint(32)
  const readString = (field: string) => {
    if (off + 4 > ext.length) {
      throw new Error(`TokenMetadata ends before the ${field} length prefix`);
    }
    const len = ext.readUInt32LE(off);
    off += 4;
    if (off + len > ext.length) {
      throw new Error(`TokenMetadata ${field} claims ${len} bytes, past the end of the extension`);
    }
    const s = ext.subarray(off, off + len).toString("utf8");
    off += len;
    return s;
  };
  const name = readString("name");
  const symbol = readString("symbol");
  return { name, symbol, mint };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const failures: string[] = [];
  const written = new Map<string, ScaledUiAmountConfig>();

  for (const mint of VERIFIED_XSTOCK_MINTS) {
    const { value, slot } = await getAccountInfo(mint.address);

    if (value.owner !== TOKEN_2022_PROGRAM) {
      failures.push(`${mint.symbol}: owner is ${value.owner}, not Token-2022`);
      continue;
    }
    const data = Buffer.from(value.data[0], "base64");
    if (data.length < MINT_BASE_LEN) {
      failures.push(`${mint.symbol}: account is ${data.length} bytes, too short for a mint`);
      continue;
    }

    const decimals = data.readUInt8(DECIMALS_OFFSET);
    const scaled = decodeScaledUiAmountConfig(data);

    // An unidentified mint never becomes a fixture. ADR-012 exists because an
    // address can be anything; the mint's own metadata is what ties it to a name.
    let metadata: TokenMetadata | null;
    try {
      metadata = decodeTokenMetadata(data);
    } catch (err) {
      failures.push(
        `${mint.symbol}: TokenMetadata is unreadable (${err instanceof Error ? err.message : String(err)}), ` +
          `so the mint cannot report its own identity`,
      );
      continue;
    }
    if (!metadata) {
      failures.push(
        `${mint.symbol}: mint carries no TokenMetadata extension, so it never reports the symbol ` +
          `"${mint.symbol}"; an unidentified mint is not a verified fixture (ADR-012)`,
      );
      continue;
    }
    if (metadata.symbol !== mint.symbol) {
      failures.push(
        `${mint.symbol}: mint metadata says symbol "${metadata.symbol}", allowlist says "${mint.symbol}"`,
      );
      continue;
    }
    if (metadata.mint !== mint.address) {
      failures.push(
        `${mint.symbol}: TokenMetadata names mint ${metadata.mint}, but this account was read from ` +
          `${mint.address}; the bytes do not belong to the address they are saved under`,
      );
      continue;
    }

    const recorded = SPEC_RECORDED[mint.symbol];
    if (recorded) {
      if (
        scaled.multiplier !== recorded.multiplier ||
        scaled.newMultiplier !== recorded.newMultiplier ||
        scaled.newMultiplierEffectiveTimestamp !== recorded.ts
      ) {
        failures.push(
          `${mint.symbol}: live values (${scaled.multiplier}, ${scaled.newMultiplier}, ` +
            `${scaled.newMultiplierEffectiveTimestamp}) differ from the values SPEC 9b.1 records ` +
            `(${recorded.multiplier}, ${recorded.newMultiplier}, ${recorded.ts}). The mint has moved, ` +
            `so SPEC 9b.1 and the G1 vectors in SPEC section 10 are stale. Stop and record it in ` +
            `OPEN-QUESTIONS.md; the build does not update the spec.`,
        );
        continue;
      }
    }

    writeFileSync(
      join(OUT_DIR, `${mint.symbol}.json`),
      JSON.stringify(
        {
          symbol: mint.symbol,
          name: mint.name,
          address: mint.address,
          source: mint.source,
          owner: value.owner,
          lamports: value.lamports,
          decimals,
          dataLen: data.length,
          dataBase64: value.data[0],
          onChainMetadata: metadata,
          decodedScaledUiAmountConfig: scaled,
          fetchedAt,
          slot,
          rpc: RPC,
        },
        null,
        2,
      ) + "\n",
    );

    written.set(mint.symbol, scaled);

    console.log(
      `${mint.symbol.padEnd(6)} ${mint.address}  decimals=${decimals}  ` +
        `multiplier=${scaled.multiplier}  newMultiplier=${scaled.newMultiplier}  ` +
        `effectiveAt=${scaled.newMultiplierEffectiveTimestamp}  slot=${slot}`,
    );
  }

  // The NFLXx acceptance values from SPEC 9b.1: a real 10-for-1 split whose
  // multiplier field still reads 1, so a reader that ignores the effective
  // timestamp values it at a tenth.
  const s = written.get("NFLXx");
  if (!s) {
    failures.push("NFLXx acceptance: no fixture was written, cannot assert");
  } else {
    const expected = { multiplier: 1, newMultiplier: 10, ts: "1763337300" };
    if (
      s.multiplier !== expected.multiplier ||
      s.newMultiplier !== expected.newMultiplier ||
      s.newMultiplierEffectiveTimestamp !== expected.ts
    ) {
      failures.push(
        `NFLXx acceptance: expected multiplier ${expected.multiplier}, newMultiplier ` +
          `${expected.newMultiplier}, ts ${expected.ts}; got ${s.multiplier}, ` +
          `${s.newMultiplier}, ${s.newMultiplierEffectiveTimestamp}`,
      );
    } else {
      console.log("NFLXx acceptance OK: multiplier 1, newMultiplier 10, ts 1763337300");
    }
  }

  // T00 requires a fixture for every symbol it names. Checked against the
  // requirement rather than against the allowlist, so shortening the allowlist
  // fails the task instead of redefining what "all of them" means.
  for (const symbol of REQUIRED_FIXTURE_SYMBOLS) {
    if (!written.has(symbol)) {
      failures.push(`T00 requires a fixture for ${symbol}; none was written`);
    }
  }

  if (failures.length > 0) {
    console.error("\nFAILURES:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }

  // T00 requires four fixtures. Missing addresses are reported, never invented
  // and never quietly dropped: the task stays incomplete until they are sourced.
  if (MINTS_AWAITING_ADDRESS.length > 0) {
    console.error(
      `\nT00 INCOMPLETE: ${VERIFIED_XSTOCK_MINTS.length} of 4 fixtures written. ` +
        `No verified address yet for: ${MINTS_AWAITING_ADDRESS.join(", ")}. ` +
        `See OPEN-QUESTIONS.md. Resolving these by symbol is forbidden (SPEC 9b.3).`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
