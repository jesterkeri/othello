/**
 * The three instructions ANYONE may send (SPEC §5): release_pot, update_coverage and
 * declare_default. Nothing runs by itself in Othello; these are how a visitor with any devnet
 * wallet moves the demo circle on. Built from the deployed program's IDL with every account
 * named, signed only in the visitor's own wallet: the app never holds a key.
 *
 * Each takes the circle's member wallets in turn order: the program wants every Member account,
 * writable, in that order, as remaining accounts.
 *
 * No "@/" imports: tests/app-actions.spec.ts sends these to the devnet build in bankrun.
 */
import * as anchor from "@coral-xyz/anchor";

import { IDL, memberAddress } from "./live";

type PublicKeyT = anchor.web3.PublicKey;
type Builder = {
  accountsStrict(a: Record<string, PublicKeyT>): Builder;
  remainingAccounts(a: anchor.web3.AccountMeta[]): Builder;
  instruction(): Promise<anchor.web3.TransactionInstruction>;
};

const { PublicKey, SystemProgram } = anchor.web3;
// Anchor's BN, whether the module arrives as a namespace (Next's bundle) or as CommonJS behind a
// default export (node's ESM loader in the tests).
// Reflect.get keeps webpack from flagging a default export anchor's ESM build does not declare.
const BN: typeof anchor.BN = (anchor as unknown as { BN?: typeof anchor.BN }).BN ?? (Reflect.get(anchor, "default") as { BN: typeof anchor.BN }).BN;
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export type CircleKeys = {
  circle: PublicKeyT;
  usdcMint: PublicKeyT;
  stockMint: PublicKeyT;
  /** Member wallets, in turn order. */
  members: PublicKeyT[];
};

function ata(owner: PublicKeyT, mint: PublicKeyT, tokenProgram: PublicKeyT): PublicKeyT {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN)[0];
}

function program() {
  const p = new anchor.Program(IDL, { connection: undefined } as unknown as anchor.Provider);
  return { id: p.programId, methods: p.methods as unknown as Record<string, (...args: unknown[]) => Builder> };
}

function pda(programId: PublicKeyT, seeds: Uint8Array[]): PublicKeyT {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function memberMetas(programId: PublicKeyT, k: CircleKeys): anchor.web3.AccountMeta[] {
  return k.members.map((w) => ({ pubkey: memberAddress(programId, k.circle, w), isSigner: false, isWritable: true }));
}

const feedOf = (programId: PublicKeyT, k: CircleKeys) => pda(programId, [Buffer.from("price"), k.stockMint.toBytes()]);

/** Pays this round's pot to its recipient. `recipient` is members[round]. */
export async function releasePotIx(caller: PublicKeyT, k: CircleKeys, recipient: PublicKeyT) {
  const { id, methods } = program();
  return methods.releasePot!()
    .accountsStrict({
      caller,
      circle: k.circle,
      stockMint: k.stockMint,
      usdcMint: k.usdcMint,
      priceFeed: feedOf(id, k),
      recipient,
      recipientUsdcAta: ata(recipient, k.usdcMint, SPL_TOKEN),
      circleUsdcVault: ata(k.circle, k.usdcMint, SPL_TOKEN),
      usdcTokenProgram: SPL_TOKEN,
      associatedTokenProgram: ASSOCIATED_TOKEN,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(memberMetas(id, k))
    .instruction();
}

/** Recomputes every member's coverage at the current price. */
export async function updateCoverageIx(caller: PublicKeyT, k: CircleKeys) {
  const { id, methods } = program();
  return methods.updateCoverage!()
    .accountsStrict({ caller, circle: k.circle, stockMint: k.stockMint, priceFeed: feedOf(id, k) })
    .remainingAccounts(memberMetas(id, k))
    .instruction();
}

/** Declares seat `turn` (0-based) in default: its stock is sold to the pool to cover what it owes. */
export async function declareDefaultIx(caller: PublicKeyT, k: CircleKeys, turn: number) {
  const { id, methods } = program();
  const pool = pda(id, [Buffer.from("pool"), k.usdcMint.toBytes(), k.stockMint.toBytes()]);
  return methods.declareDefault!(turn)
    .accountsStrict({
      caller,
      circle: k.circle,
      stockMint: k.stockMint,
      usdcMint: k.usdcMint,
      priceFeed: feedOf(id, k),
      pool,
      circleStockVault: ata(k.circle, k.stockMint, TOKEN_2022),
      circleUsdcVault: ata(k.circle, k.usdcMint, SPL_TOKEN),
      poolStockVault: ata(pool, k.stockMint, TOKEN_2022),
      poolUsdcVault: ata(pool, k.usdcMint, SPL_TOKEN),
      stockTokenProgram: TOKEN_2022,
      usdcTokenProgram: SPL_TOKEN,
    })
    .remainingAccounts(memberMetas(id, k))
    .instruction();
}

/* ------------------------------------------------------------------------- *
 * T18g: the member's own actions (SPEC §5), signed by the member's wallet.
 * ------------------------------------------------------------------------- */

/**
 * A decimal amount typed by a person, as base units, with string arithmetic so nothing is rounded.
 * null for anything that is not a plain positive number with at most `decimals` places.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  const units = BigInt((m[1] || "0") + frac.padEnd(decimals, "0"));
  return units > 0n ? units : null;
}

/** Locks `raw` more of the circle's stock behind the member's seat (add_stock, T16). */
export async function addStockIx(wallet: PublicKeyT, k: CircleKeys, raw: bigint) {
  const { id, methods } = program();
  return methods.addStock!(new BN(raw.toString()))
    .accountsStrict({
      wallet,
      circle: k.circle,
      member: memberAddress(id, k.circle, wallet),
      stockMint: k.stockMint,
      memberStockAta: ata(wallet, k.stockMint, TOKEN_2022),
      circleStockVault: ata(k.circle, k.stockMint, TOKEN_2022),
      stockTokenProgram: TOKEN_2022,
    })
    .instruction();
}

/** Adds `amount` test USDC to the reserve (top_up_reserve, SPEC §5): it fills the escrow deficit first. */
export async function topUpReserveIx(wallet: PublicKeyT, k: CircleKeys, amount: bigint) {
  const { id, methods } = program();
  return methods.topUpReserve!(new BN(amount.toString()))
    .accountsStrict({
      wallet,
      circle: k.circle,
      member: memberAddress(id, k.circle, wallet),
      usdcMint: k.usdcMint,
      memberUsdcAta: ata(wallet, k.usdcMint, SPL_TOKEN),
      circleUsdcVault: ata(k.circle, k.usdcMint, SPL_TOKEN),
      usdcTokenProgram: SPL_TOKEN,
    })
    .instruction();
}

/** The member takes back their stock, unused guarantee and top-ups once the circle has ended (withdraw, SPEC §7). */
export async function withdrawIx(wallet: PublicKeyT, k: CircleKeys) {
  const { id, methods } = program();
  return methods.withdraw!()
    .accountsStrict({
      wallet,
      circle: k.circle,
      member: memberAddress(id, k.circle, wallet),
      stockMint: k.stockMint,
      usdcMint: k.usdcMint,
      memberStockAta: ata(wallet, k.stockMint, TOKEN_2022),
      memberUsdcAta: ata(wallet, k.usdcMint, SPL_TOKEN),
      circleStockVault: ata(k.circle, k.stockMint, TOKEN_2022),
      circleUsdcVault: ata(k.circle, k.usdcMint, SPL_TOKEN),
      stockTokenProgram: TOKEN_2022,
      usdcTokenProgram: SPL_TOKEN,
      associatedTokenProgram: ASSOCIATED_TOKEN,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}
