/**
 * T18g: Buy in place (Joshua: "users should be able to perform the entire transaction in our site").
 * Jupiter builds the swap; the buyer signs it in their own wallet; our server relays the signed bytes
 * to mainnet. Othello never holds a key or funds. These checks run on the server before a transaction
 * leaves it and before a signed one is relayed, so neither route can be used to hand a wallet, or push
 * to mainnet, anything but a Jupiter swap paid for by the buyer.
 *
 * No "@/" imports: tests/app-swap.spec.ts loads this file directly.
 */
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
  if (signed && !(tx.signatures[0] ?? new Uint8Array(64)).some((b) => b !== 0)) return { ok: false, reason: "the transaction is not signed by this wallet" };
  return { ok: true, tx };
}
