/**
 * T18g: Buy in place (Joshua: "users should be able to perform the entire transaction in our site").
 * Jupiter builds the swap; the buyer signs it in their own wallet; our server relays the signed bytes
 * to mainnet. Othello never holds a key or funds. These checks run on the server before a transaction
 * leaves it and before a signed one is relayed, so neither route can be used to hand a wallet, or push
 * to mainnet, anything but a Jupiter swap paid for by the buyer.
 *
 * No "@/" imports: tests/app-swap.spec.ts loads this file directly.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

/**
 * Jupiter's swap program (v6), read from a transaction Jupiter's /swap built on 2026-09-25
 * (tests/fixtures/jup-swap-qqqx.json). An earlier value was typed from memory and was wrong, so every
 * real Jupiter transaction was refused: the fixture now pins it.
 */
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/**
 * The only programs a Jupiter USDC-to-xStock swap invokes at top level, as the recorded transaction
 * shows (tests/fixtures/jup-swap-qqqx.json): Compute Budget, the Associated Token program (only to
 * create the buyer's account), and Jupiter. No token program at top level (Codex T18d r5: a token
 * transfer beside Jupiter moved funds elsewhere), no System program.
 */
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ALLOWED_PROGRAMS = new Set([COMPUTE_BUDGET, ASSOCIATED_TOKEN, JUPITER_PROGRAM]);
/** Solana's packet limit: nothing larger can be a transaction. */
export const MAX_TX_BYTES = 1232;

export type TxCheck = { ok: true; tx: VersionedTransaction } | { ok: false; reason: string };

/**
 * A base64 transaction is acceptable only if it decodes, fits in a packet, is paid for by `payer`,
 * and invokes Jupiter's swap program. With `signed`, the payer's signature must also be present.
 */
export function checkSwapTx(base64: string, payer: string, signed: boolean): TxCheck {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { ok: false, reason: "not a base64 transaction" };
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  if (bytes.length === 0 || bytes.length > MAX_TX_BYTES) return { ok: false, reason: "not a transaction (size)" };
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    return { ok: false, reason: "not a transaction (does not decode)" };
  }
  const keys = tx.message.staticAccountKeys;
  if (!keys[0] || !keys[0].equals(new PublicKey(payer))) return { ok: false, reason: "the transaction is not paid for by this wallet" };
  const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58());
  if (!programs.includes(JUPITER_PROGRAM)) return { ok: false, reason: "the transaction is not a Jupiter swap" };
  const other = programs.find((p) => !p || !ALLOWED_PROGRAMS.has(p));
  if (other !== undefined) return { ok: false, reason: "the transaction does more than a Jupiter swap" };
  // The Associated Token program may only create (0) or create-idempotent (1) an account: its
  // RecoverNested (2) moves tokens.
  const atokenOther = tx.message.compiledInstructions.some(
    (ix) => keys[ix.programIdIndex]?.toBase58() === ASSOCIATED_TOKEN && !(ix.data.length === 0 || (ix.data.length === 1 && ix.data[0]! <= 1)),
  );
  if (atokenOther) return { ok: false, reason: "the transaction does more than a Jupiter swap" };
  // B1 (Codex fresh review, MINOR): "signed" means a valid Ed25519 signature by the fee payer over this
  // exact message, not merely nonzero bytes.
  if (signed && !feePayerSignatureValid(tx)) return { ok: false, reason: "the transaction is not signed by this wallet" };
  return { ok: true, tx };
}

/* ------------------------------------------------------------------------- *
 * Codex T18d final round: what the instructions DO, not only which programs.
 * The swap's output mint and token program live in an address lookup table, so
 * the account list is resolved first (static keys, then each table's writable,
 * then readonly entries: the v0 message order).
 * ------------------------------------------------------------------------- */

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** An address lookup table account: a 56-byte header, then 32-byte addresses. */
const LUT_HEADER = 56;

/*
 * Jupiter V6 `route`, and no other Jupiter instruction, is accepted. Its discriminator and ordered
 * account list are from Jupiter's published V6 IDL (retrieved 2026-09-26):
 * https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts
 *
 * The IDL names the accounts in this order; the Route discriminator is the IDL's Anchor
 * `global:route` discriminator, e517cb977ae3ad2a. Keep names rather than anonymous numeric indices so
 * a future mapping is auditable against the published IDL.
 */
const JUPITER_ROUTE_DISCRIMINATOR = Uint8Array.from([229, 23, 203, 151, 122, 227, 173, 42]);
const JUPITER_ROUTE_ACCOUNTS = [
  "tokenProgram",
  "userTransferAuthority",
  "userSourceTokenAccount",
  "userDestinationTokenAccount",
  "destinationTokenAccount",
  "destinationMint",
  "platformFeeAccount",
] as const;

function isDiscriminator(data: Uint8Array, expected: Uint8Array): boolean {
  return data.length >= expected.length && expected.every((byte, i) => data[i] === byte);
}

function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN),
  )[0].toBase58();
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    encoded = BASE58[Number(number % 58n)]! + encoded;
    number /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return "1".repeat(zeroes) + encoded;
}

/**
 * Signature zero must be a valid Ed25519 signature by static account key zero (the fee payer) over the
 * message, checked as strictly as Solana does (verify_strict): RFC 8032 rules without ZIP-215's leniency
 * (canonical S and point encodings), and neither the public key nor the signature's R is a small-order
 * point. OpenSSL's lenient verify accepted a keyless "signature" for the identity key (B1 seal adversary).
 */
export function feePayerSignatureValid(tx: VersionedTransaction): boolean {
  const signature = tx.signatures[0];
  const payer = tx.message.staticAccountKeys[0];
  if (!signature || signature.length !== 64 || !payer) return false;
  try {
    const key = payer.toBytes();
    const point = ed25519.ExtendedPoint;
    if (point.fromHex(key).isSmallOrder() || point.fromHex(signature.subarray(0, 32)).isSmallOrder()) return false;
    return ed25519.verify(signature, tx.message.serialize(), key, { zip215: false });
  } catch {
    return false;
  }
}

/** The first signature belongs to message account key zero, the fee payer. */
export function signedTransactionSignature(tx: VersionedTransaction): string | null {
  const signature = tx.signatures[0];
  return signature && signature.some((byte) => byte !== 0) ? base58(signature) : null;
}

/** The v0 account list with lookup tables resolved; null if a table is missing or too short. */
export function resolveKeys(tx: VersionedTransaction, tables: Record<string, Uint8Array>): string[] | null {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const lookups = tx.message.addressTableLookups;
  const at = (table: string, i: number) => {
    const d = tables[table];
    const off = LUT_HEADER + i * 32;
    return d && d.length >= off + 32 ? new PublicKey(d.subarray(off, off + 32)).toBase58() : null;
  };
  for (const pass of ["writableIndexes", "readonlyIndexes"] as const) {
    for (const l of lookups) {
      for (const i of l[pass]) {
        const k = at(l.accountKey.toBase58(), i);
        if (!k) return null;
        keys.push(k);
      }
    }
  }
  return keys;
}

/** Reads each lookup table the transaction uses (base64 getAccountInfo) from `rpcUrl`. */
export async function fetchLookupTables(rpcUrl: string, tx: VersionedTransaction): Promise<Record<string, Uint8Array> | null> {
  const out: Record<string, Uint8Array> = {};
  for (const l of tx.message.addressTableLookups) {
    const addr = l.accountKey.toBase58();
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [addr, { encoding: "base64" }] }) }).catch(() => null);
    const body = res && res.ok ? ((await res.json().catch(() => null)) as { result?: { value?: { data?: [string, string] } | null } } | null) : null;
    const data = body?.result?.value?.data?.[0];
    if (typeof data !== "string") return null;
    out[addr] = Uint8Array.from(Buffer.from(data, "base64"));
  }
  return out;
}

/** Compute budget limits: at most 1.4M units, at most 1 lamport per unit of priority fee (1,000,000 micro-lamports). */
export const MAX_CU = 1_400_000;
export const MAX_CU_PRICE = 1_000_000n;

/** The slippage /api/swap requests from Jupiter; a route allowing more was not built by Othello. */
export const MAX_SLIPPAGE_BPS = 100;
const ROUTE_TAIL_BYTES = 8 + 8 + 2 + 1;

export type RouteTail = { inAmount: bigint; quotedOut: bigint; slippageBps: number; platformFeeBps: number };

/**
 * The route's arguments end with fixed-size fields after the variable-length route plan:
 * in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8 (IDL order, little-endian).
 * The route plan itself (a vector of steps over 100+ swap variants) is not decoded: a stated limit.
 */
export function routeTail(data: Uint8Array): RouteTail | null {
  if (!isDiscriminator(data, JUPITER_ROUTE_DISCRIMINATOR) || data.length < JUPITER_ROUTE_DISCRIMINATOR.length + 4 + ROUTE_TAIL_BYTES) return null;
  const tail = new DataView(data.buffer, data.byteOffset + data.length - ROUTE_TAIL_BYTES, ROUTE_TAIL_BYTES);
  return { inAmount: tail.getBigUint64(0, true), quotedOut: tail.getBigUint64(8, true), slippageBps: tail.getUint16(16, true), platformFeeBps: tail.getUint8(18) };
}

/** The single Jupiter route instruction's arguments, or null (checkSwapAccounts has already refused anything else). */
export function jupiterRouteTail(tx: VersionedTransaction, keys: string[]): RouteTail | null {
  const routes = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === JUPITER_PROGRAM);
  return routes.length === 1 ? routeTail(routes[0]!.data) : null;
}

/**
 * With the account list resolved: every compute-budget instruction only sets a bounded unit limit or
 * price; each supported Jupiter instruction sends the quoted asset from the buyer's USDC ATA to the
 * buyer's Token-2022 ATA for the listed stock; and an ATA create can only create one of those two ATAs.
 */
export function checkSwapAccounts(tx: VersionedTransaction, keys: string[], payer: string, mint: string): string | null {
  let inputAta: string;
  let outputAta: string;
  try {
    inputAta = associatedTokenAddress(payer, USDC_MINT, TOKEN_PROGRAM);
    outputAta = associatedTokenAddress(payer, mint, TOKEN_2022_PROGRAM);
  } catch {
    return "the transaction has invalid swap accounts";
  }

  const jupiter = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === JUPITER_PROGRAM);
  if (jupiter.length !== 1) return "the transaction is not a single Jupiter swap";
  const route = jupiter[0]!;
  if (!isDiscriminator(route.data, JUPITER_ROUTE_DISCRIMINATOR)) return "the transaction uses an unsupported Jupiter instruction";
  const routeAccounts = route.accountKeyIndexes.map((i) => keys[i]);
  const routeAccount = (name: (typeof JUPITER_ROUTE_ACCOUNTS)[number]) => routeAccounts[JUPITER_ROUTE_ACCOUNTS.indexOf(name)];
  if (routeAccounts.length < JUPITER_ROUTE_ACCOUNTS.length - 1) return "the transaction's Jupiter route is missing required accounts";
  // `destinationTokenAccount` is optional in the IDL and, when provided, is the account that receives the
  // output (Jupiter Swap API: "token account that will be used to receive the token out of the swap").
  // Anchor encodes "not provided" as the program id itself, which is what the real fixture carries.
  const destination = routeAccount("destinationTokenAccount");
  if (
    routeAccount("tokenProgram") !== TOKEN_2022_PROGRAM
    || routeAccount("userTransferAuthority") !== payer
    || routeAccount("userSourceTokenAccount") !== inputAta
    || routeAccount("userDestinationTokenAccount") !== outputAta
    || (destination !== JUPITER_PROGRAM && destination !== outputAta)
    || routeAccount("destinationMint") !== mint
  ) return "the transaction does not send the listed stock to the buyer's token account";

  const tail = routeTail(route.data);
  if (!tail) return "the transaction's Jupiter route is malformed";
  const { inAmount, quotedOut, slippageBps, platformFeeBps } = tail;
  if (routeAccount("platformFeeAccount") !== JUPITER_PROGRAM || platformFeeBps !== 0) return "the transaction charges a platform fee";
  if (inAmount === 0n || quotedOut === 0n || slippageBps > MAX_SLIPPAGE_BPS) return "the transaction's Jupiter route has unsafe amounts";

  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    const d = ix.data;
    if (program === COMPUTE_BUDGET) {
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      if (d[0] === 2 && d.length === 5 && view.getUint32(1, true) <= MAX_CU) continue;
      if (d[0] === 3 && d.length === 9 && view.getBigUint64(1, true) <= MAX_CU_PRICE) continue;
      return "the transaction sets an unexpected compute budget";
    }
    if (program === ASSOCIATED_TOKEN) {
      const a = ix.accountKeyIndexes.map((i) => keys[i]);
      const outputCreate = a[1] === outputAta && a[3] === mint && a[5] === TOKEN_2022_PROGRAM;
      const inputCreate = a[1] === inputAta && a[3] === USDC_MINT && a[5] === TOKEN_PROGRAM;
      if (a.length !== 6 || a[0] !== payer || a[2] !== payer || a[4] !== SYSTEM_PROGRAM || (!outputCreate && !inputCreate)) return "the transaction creates a token account other than the buyer's input or output ATA";
    }
  }
  return null;
}
