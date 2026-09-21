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
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERIFIED_XSTOCK_MINTS,
  MINTS_AWAITING_ADDRESS,
  REQUIRED_FIXTURE_SYMBOLS,
} from "./xstock-mints.ts";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OUT_DIR = join(process.cwd(), "tests", "fixtures");
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Solana mainnet-beta genesis hash, read from https://api.mainnet-beta.solana.com
 * via getGenesisHash on 2026-09-21. SOLANA_RPC_URL can point anywhere, so without
 * this an endpoint could serve four well-formed Token-2022-shaped accounts and the
 * run would exit 0 while claiming every byte came from mainnet.
 */
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * Issuer provenance for the xStock family.
 *
 * A mint's own TokenMetadata is self-reported: an attacker-controlled Token-2022
 * mint can name itself SPYx and embed its own address. These three anchors are not
 * self-reported, because forging them needs Backed's keys. They are the values
 * carried by AAPLx and NFLXx, the two mints SPEC 9b.1 pins independently of this
 * script, so the two addresses that came from a web page are tied to the same
 * issuer as the two the design session verified.
 */
const BACKED_SCALED_UI_AUTHORITY = "S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS";
const BACKED_METADATA_UPDATE_AUTHORITY = "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq";
const BACKED_METADATA_HOST = "xstocks-metadata.backed.fi";

// Token-2022 mint layout: the base mint is 82 bytes, then one account-type byte,
// then TLV extension entries.
const MINT_BASE_LEN = 82;
const DECIMALS_OFFSET = 44;
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;

const EXT_TOKEN_METADATA = 19;
const EXT_SCALED_UI_AMOUNT = 25;

// ScaledUiAmountConfig is exactly 56 bytes: authority(32) multiplier(8)
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

type TokenMetadata = { name: string; symbol: string; mint: string; updateAuthority: string; uri: string };

type ScaledUiAmountConfig = {
  authority: string;
  multiplier: number;
  newMultiplierEffectiveTimestamp: string;
  newMultiplier: number;
};

async function rpcCall(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status} ${res.statusText} for ${method}`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`RPC error for ${method}: ${JSON.stringify(body.error)}`);
  return body;
}

/** Refuse to treat any endpoint's answers as mainnet bytes until it proves it is mainnet. */
async function assertMainnet() {
  const body = await rpcCall("getGenesisHash", []);
  const hash = body.result as string;
  if (hash !== MAINNET_GENESIS_HASH) {
    throw new Error(
      `${RPC} reports genesis hash ${hash}, not mainnet-beta's ${MAINNET_GENESIS_HASH}. ` +
        `Fixtures must be real mainnet bytes (ADR-012), so nothing from this endpoint is accepted.`,
    );
  }
}

async function getAccountInfo(address: string) {
  const body = await rpcCall("getAccountInfo", [
    address,
    { encoding: "base64", commitment: "finalized" },
  ]);
  if (!body.result?.value) throw new Error(`account not found on mainnet: ${address}`);
  return { value: body.result.value, slot: body.result.context.slot as number };
}

/**
 * Parse the whole TLV region strictly. A lenient reader is a hole: trailing bytes,
 * a duplicated extension, or an overlong entry all mean the account is not the
 * shape being claimed, and a reader that shrugs lets an attacker choose which copy
 * of an extension is believed.
 */
function parseExtensions(data: Buffer): Map<number, Buffer> {
  if (data.length < MINT_BASE_LEN) {
    throw new Error(`account is ${data.length} bytes, too short for a mint`);
  }
  if (data.length <= ACCOUNT_TYPE_OFFSET) {
    throw new Error(`account is ${data.length} bytes, too short to carry extensions`);
  }
  const accountType = data.readUInt8(ACCOUNT_TYPE_OFFSET);
  if (accountType !== ACCOUNT_TYPE_MINT) {
    throw new Error(`account type is ${accountType}, not a Token-2022 mint (${ACCOUNT_TYPE_MINT})`);
  }

  const out = new Map<number, Buffer>();
  let off = ACCOUNT_TYPE_OFFSET + 1;
  while (off < data.length) {
    if (off + 4 > data.length) {
      throw new Error(`TLV region has ${data.length - off} trailing bytes, too few for a header`);
    }
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    const start = off + 4;
    if (start + len > data.length) {
      throw new Error(`TLV entry type ${type} claims ${len} bytes, past the end of the account`);
    }
    if (out.has(type)) {
      throw new Error(`TLV entry type ${type} appears more than once`);
    }
    out.set(type, data.subarray(start, start + len));
    off = start + len;
  }
  if (off !== data.length) {
    throw new Error(`TLV region ends at ${off} but the account is ${data.length} bytes`);
  }
  return out;
}

function decodeScaledUiAmountConfig(exts: Map<number, Buffer>): ScaledUiAmountConfig {
  const ext = exts.get(EXT_SCALED_UI_AMOUNT);
  if (!ext) throw new Error("ScaledUiAmountConfig extension absent");
  if (ext.length !== SCALED_UI_AMOUNT_LEN) {
    throw new Error(
      `ScaledUiAmountConfig is ${ext.length} bytes, not the expected ${SCALED_UI_AMOUNT_LEN}`,
    );
  }
  return {
    authority: toBase58(ext.subarray(0, 32)),
    multiplier: ext.readDoubleLE(32),
    newMultiplierEffectiveTimestamp: ext.readBigInt64LE(40).toString(),
    newMultiplier: ext.readDoubleLE(48),
  };
}

/**
 * Read the mint's own TokenMetadata. Absent means null; present but malformed
 * throws. Swallowing a malformed extension into null would let an issuer disable
 * the identity check by corrupting a length prefix.
 */
function decodeTokenMetadata(exts: Map<number, Buffer>): TokenMetadata | null {
  const ext = exts.get(EXT_TOKEN_METADATA);
  if (!ext) return null;
  if (ext.length < 64) {
    throw new Error(`TokenMetadata is ${ext.length} bytes, too short to hold its own mint pubkey`);
  }
  const updateAuthority = toBase58(ext.subarray(0, 32));
  const mint = toBase58(ext.subarray(32, 64));
  let off = 64;
  const readString = (field: string) => {
    if (off + 4 > ext.length) throw new Error(`TokenMetadata ends before the ${field} length prefix`);
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
  const uri = readString("uri");
  return { name, symbol, mint, updateAuthority, uri };
}

async function main() {
  await assertMainnet();

  const fetchedAt = new Date().toISOString();
  const failures: string[] = [];
  const written = new Map<string, ScaledUiAmountConfig>();
  const staged: { symbol: string; json: string; line: string }[] = [];

  for (const mint of VERIFIED_XSTOCK_MINTS) {
    const { value, slot } = await getAccountInfo(mint.address);

    if (value.owner !== TOKEN_2022_PROGRAM) {
      failures.push(`${mint.symbol}: owner is ${value.owner}, not Token-2022`);
      continue;
    }
    const data = Buffer.from(value.data[0], "base64");

    let exts: Map<number, Buffer>;
    let scaled: ScaledUiAmountConfig;
    let metadata: TokenMetadata | null;
    try {
      exts = parseExtensions(data);
      scaled = decodeScaledUiAmountConfig(exts);
      metadata = decodeTokenMetadata(exts);
    } catch (err) {
      failures.push(`${mint.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const decimals = data.readUInt8(DECIMALS_OFFSET);

    // An unidentified mint never becomes a fixture.
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

    // Self-reported fields above prove nothing on their own: anyone can mint a
    // Token-2022 token that calls itself SPYx and points at itself. These three
    // need Backed's keys, and they are the values the SPEC-pinned mints carry.
    if (scaled.authority !== BACKED_SCALED_UI_AUTHORITY) {
      failures.push(
        `${mint.symbol}: scaled-UI authority is ${scaled.authority}, not the xStock issuer ` +
          `${BACKED_SCALED_UI_AUTHORITY} that the SPEC-pinned mints carry`,
      );
      continue;
    }
    if (metadata.updateAuthority !== BACKED_METADATA_UPDATE_AUTHORITY) {
      failures.push(
        `${mint.symbol}: metadata update authority is ${metadata.updateAuthority}, not the xStock ` +
          `issuer ${BACKED_METADATA_UPDATE_AUTHORITY}`,
      );
      continue;
    }
    let uriHost: string;
    try {
      uriHost = new URL(metadata.uri).host;
    } catch {
      failures.push(`${mint.symbol}: metadata uri "${metadata.uri}" is not a URL`);
      continue;
    }
    if (uriHost !== BACKED_METADATA_HOST || !metadata.uri.includes(`/${mint.symbol}/`)) {
      failures.push(
        `${mint.symbol}: metadata uri ${metadata.uri} is not a ${BACKED_METADATA_HOST} document ` +
          `naming ${mint.symbol}`,
      );
      continue;
    }

    const recorded = SPEC_RECORDED[mint.symbol];
    if (
      recorded &&
      (scaled.multiplier !== recorded.multiplier ||
        scaled.newMultiplier !== recorded.newMultiplier ||
        scaled.newMultiplierEffectiveTimestamp !== recorded.ts)
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

    written.set(mint.symbol, scaled);
    staged.push({
      symbol: mint.symbol,
      json:
        JSON.stringify(
          {
            symbol: mint.symbol,
            name: mint.name,
            address: mint.address,
            source: mint.source,
            owner: value.owner,
            decimals,
            dataLen: data.length,
            dataBase64: value.data[0],
            onChainMetadata: metadata,
            decodedScaledUiAmountConfig: scaled,
            fetchedAt,
            slot,
            rpc: RPC,
            genesisHash: MAINNET_GENESIS_HASH,
          },
          null,
          2,
        ) + "\n",
      line:
        `${mint.symbol.padEnd(6)} ${mint.address}  decimals=${decimals}  ` +
        `multiplier=${scaled.multiplier}  newMultiplier=${scaled.newMultiplier}  ` +
        `effectiveAt=${scaled.newMultiplierEffectiveTimestamp}  slot=${slot}`,
    });
  }

  // The NFLXx acceptance values from SPEC 9b.1: a real 10-for-1 split whose
  // multiplier field still reads 1, so a reader that ignores the effective
  // timestamp values it at a tenth.
  const nflx = written.get("NFLXx");
  if (!nflx) {
    failures.push("NFLXx acceptance: no fixture was staged, cannot assert");
  } else {
    const expected = { multiplier: 1, newMultiplier: 10, ts: "1763337300" };
    if (
      nflx.multiplier !== expected.multiplier ||
      nflx.newMultiplier !== expected.newMultiplier ||
      nflx.newMultiplierEffectiveTimestamp !== expected.ts
    ) {
      failures.push(
        `NFLXx acceptance: expected multiplier ${expected.multiplier}, newMultiplier ` +
          `${expected.newMultiplier}, ts ${expected.ts}; got ${nflx.multiplier}, ` +
          `${nflx.newMultiplier}, ${nflx.newMultiplierEffectiveTimestamp}`,
      );
    }
  }

  // T00 requires a fixture for every symbol it names, checked against the
  // requirement rather than the allowlist, so shortening the allowlist fails the
  // task instead of redefining what "all of them" means.
  for (const symbol of REQUIRED_FIXTURE_SYMBOLS) {
    if (!written.has(symbol)) failures.push(`T00 requires a fixture for ${symbol}; none was written`);
  }
  if (MINTS_AWAITING_ADDRESS.length > 0) {
    failures.push(
      `no verified address yet for: ${MINTS_AWAITING_ADDRESS.join(", ")}. See OPEN-QUESTIONS.md. ` +
        `Resolving these by symbol is forbidden (SPEC 9b.3).`,
    );
  }

  // Nothing touches tests/fixtures until every mint has passed. A partial write
  // leaves a mixed snapshot: some fixtures from this run, some from a previous
  // one, and T03/T06 would load that blend as if it were one observation.
  if (failures.length > 0) {
    console.error("FAILURES:");
    for (const f of failures) console.error(`  ${f}`);
    console.error("\nNo fixture was written; tests/fixtures is unchanged.");
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "othello-fixtures-"));
  try {
    for (const s of staged) writeFileSync(join(tmp, `${s.symbol}.json`), s.json);
    mkdirSync(OUT_DIR, { recursive: true });
    for (const s of staged) renameSync(join(tmp, `${s.symbol}.json`), join(OUT_DIR, `${s.symbol}.json`));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  for (const s of staged) console.log(s.line);
  console.log("NFLXx acceptance OK: multiplier 1, newMultiplier 10, ts 1763337300");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
