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
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * Where trust comes from, and where it does not.
 *
 * NOT trust: a mint's own TokenMetadata symbol, its embedded mint pubkey, its
 * scaled-UI authority and its metadata update authority. Token-2022 takes both
 * authorities as non-signer instruction data, so a counterfeit mint can carry
 * Backed's public keys without holding them, and the metadata URI is a string the
 * mint's creator chose. These are kept below as integrity and drift checks only.
 *
 * Trust: `productPage` on each allowlist entry, fetched over TLS at a URL derived
 * from the symbol in this repo rather than from anything the mint says. Backed's own
 * site stating `data-network-address="<address>"` is the issuer asserting the
 * binding; forging it needs backed.fi's TLS or DNS. Named as the trust root in
 * OPEN-QUESTIONS.md rather than left implicit.
 */
const BACKED_NETWORK_ATTR = "data-network-address";
const BACKED_ORIGIN = "https://assets.backed.fi";

/**
 * Integrity and drift values, NOT provenance. Every known xStock mint carries these,
 * so a mismatch means the account has changed shape or the address points at
 * something unrelated. A counterfeit mint can copy all three, which is why they
 * never stand alone.
 */
const BACKED_SCALED_UI_AUTHORITY = "S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS";
const BACKED_METADATA_UPDATE_AUTHORITY = "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq";
const BACKED_METADATA_HOST = "xstocks-metadata.backed.fi";

/**
 * RPC transport trust. A genesis hash is public, so an endpoint returning the right
 * one proves nothing about who is answering; only the transport does. Production
 * runs therefore require HTTPS to a host on this list, and TLS authenticates it.
 */
const TRUSTED_RPC_HOSTS = ["api.mainnet-beta.solana.com"];

/**
 * The test seam, deliberately loud and deliberately separate from the production
 * path. With OTHELLO_INSECURE_TEST_RPC=1 the checks above are relaxed so a local
 * stub can drive the script, and every fixture it writes is stamped
 * endpointTrusted:false, so a fixture produced through the seam can never be
 * mistaken for a real one.
 */
const INSECURE_TEST_SEAM = process.env.OTHELLO_INSECURE_TEST_RPC === "1";
const BACKED_BASE_OVERRIDE = INSECURE_TEST_SEAM ? process.env.OTHELLO_BACKED_BASE : undefined;

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

/**
 * A genesis hash identifies a network only if the endpoint is already trusted, so
 * the transport check comes first and the genesis check is the second gate, not the
 * first.
 */
async function assertTrustedMainnetEndpoint() {
  let url: URL;
  try {
    url = new URL(RPC);
  } catch {
    throw new Error(`SOLANA_RPC_URL ${RPC} is not a URL`);
  }
  if (INSECURE_TEST_SEAM) {
    console.error(
      `WARNING: OTHELLO_INSECURE_TEST_RPC=1. ${RPC} is not authenticated and every ` +
        `fixture written by this run is stamped endpointTrusted:false. Never commit one.`,
    );
  } else {
    if (url.protocol !== "https:") {
      throw new Error(
        `SOLANA_RPC_URL ${RPC} is ${url.protocol}, not https. Without TLS the endpoint is ` +
          `unauthenticated and its bytes are not mainnet bytes (ADR-012).`,
      );
    }
    if (!TRUSTED_RPC_HOSTS.includes(url.host)) {
      throw new Error(
        `SOLANA_RPC_URL host ${url.host} is not one of the trusted endpoints ` +
          `(${TRUSTED_RPC_HOSTS.join(", ")}). A hostile endpoint can return the public ` +
          `mainnet genesis hash and then arbitrary account data.`,
      );
    }
  }
  const body = await rpcCall("getGenesisHash", []);
  const hash = body.result as string;
  if (hash !== MAINNET_GENESIS_HASH) {
    throw new Error(
      `${RPC} reports genesis hash ${hash}, not mainnet-beta's ${MAINNET_GENESIS_HASH}.`,
    );
  }
}

/**
 * The issuer's own TLS-authenticated statement that this symbol is this address.
 * The URL comes from the allowlist in this repo, never from the mint, so a hostile
 * mint cannot redirect the check at itself.
 */
async function assertIssuerBinding(symbol: string, address: string, productSlug: string) {
  const origin = BACKED_BASE_OVERRIDE ?? BACKED_ORIGIN;
  const url = `${origin}/products/${encodeURIComponent(productSlug)}`;
  if (new URL(url).origin !== new URL(origin).origin) {
    throw new Error(`${symbol}: product URL ${url} escaped the pinned origin ${origin}`);
  }

  // Redirects are refused rather than followed: a followed redirect can land on a
  // host that is not the issuer while the request still looks pinned.
  const res = await fetch(url, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `${symbol}: ${url} redirected (${res.status} to ${res.headers.get("location") ?? "unknown"}); ` +
        `the issuer binding must come from ${origin} itself`,
    );
  }
  if (!res.ok) throw new Error(`${symbol}: ${url} returned ${res.status} ${res.statusText}`);

  const html = await res.text();
  if (!html.includes(`${BACKED_NETWORK_ATTR}="${address}"`)) {
    throw new Error(
      `${symbol}: ${url} does not state ${BACKED_NETWORK_ATTR}="${address}". The issuer does ` +
        `not bind this address to ${symbol}, so it does not enter the allowlist (ADR-012).`,
    );
  }
  return url;
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
  await assertTrustedMainnetEndpoint();

  const fetchedAt = new Date().toISOString();
  const failures: string[] = [];
  const written = new Map<string, ScaledUiAmountConfig>();
  const staged: { symbol: string; json: string; line: string }[] = [];

  for (const mint of VERIFIED_XSTOCK_MINTS) {
    // The issuer's binding is checked before anything the mint says about itself.
    let issuerBinding: string;
    try {
      issuerBinding = await assertIssuerBinding(mint.symbol, mint.address, mint.productSlug);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
      continue;
    }

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

    // Integrity and drift checks, NOT provenance: all three are copyable by a
    // counterfeit mint (see the trust note at the top). They catch a mint that has
    // changed shape or an address that points at something unrelated; they do not
    // establish who issued it. That is the product-page check below.
    if (scaled.authority !== BACKED_SCALED_UI_AUTHORITY) {
      failures.push(
        `${mint.symbol}: scaled-UI authority is ${scaled.authority}, not ${BACKED_SCALED_UI_AUTHORITY}, the value ` +
          `every known xStock carries`,
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
            endpointTrusted: !INSECURE_TEST_SEAM,
            issuerBinding,
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

  // Replace the fixture SET, not file by file. Renaming four files one at a time can
  // fail midway and leave a blend of this run and the last, which T03 and T06 would
  // load as one observation. Staging sits beside the destination so the swap is a
  // same-filesystem directory rename, and a failure rolls the old set back.
  const parent = dirname(OUT_DIR);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.fixtures-staging-${process.pid}`);
  const previous = join(parent, `.fixtures-previous-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  let movedAside = false;
  try {
    for (const s of staged) writeFileSync(join(stage, `${s.symbol}.json`), s.json);
    if (existsSync(OUT_DIR)) {
      renameSync(OUT_DIR, previous);
      movedAside = true;
    }
    renameSync(stage, OUT_DIR);
    if (movedAside) rmSync(previous, { recursive: true, force: true });
  } catch (err) {
    if (movedAside && !existsSync(OUT_DIR)) renameSync(previous, OUT_DIR);
    rmSync(stage, { recursive: true, force: true });
    throw new Error(
      `fixture swap failed, previous set left in place: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const s of staged) console.log(s.line);
  console.log("NFLXx acceptance OK: multiplier 1, newMultiplier 10, ts 1763337300");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
