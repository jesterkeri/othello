/**
 * The one transaction the app sends: `contribute`, a member paying this
 * round's contribution (SPEC §5). Built from the deployed program's IDL with
 * every account named, so nothing is resolved by guesswork, and signed only in
 * the member's own wallet: the app never holds a key.
 *
 * No "@/" imports: tests/app-contribute.spec.ts sends this instruction to the
 * devnet build in bankrun.
 */
import * as anchor from "@coral-xyz/anchor";

import { IDL, memberAddress } from "./live";

type PublicKeyT = anchor.web3.PublicKey;

const SPL_TOKEN = new anchor.web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN = new anchor.web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function ata(owner: PublicKeyT, mint: PublicKeyT): PublicKeyT {
  return anchor.web3.PublicKey.findProgramAddressSync([owner.toBytes(), SPL_TOKEN.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN)[0];
}

type Builder = { accountsStrict(a: Record<string, PublicKeyT>): Builder; instruction(): Promise<anchor.web3.TransactionInstruction> };

export async function contributeIx(wallet: PublicKeyT, circle: PublicKeyT, usdcMint: PublicKeyT): Promise<anchor.web3.TransactionInstruction> {
  const program = new anchor.Program(IDL, { connection: undefined } as unknown as anchor.Provider);
  const methods = program.methods as unknown as Record<string, () => Builder>;
  return methods.contribute!()
    .accountsStrict({
      wallet,
      circle,
      member: memberAddress(program.programId, circle, wallet),
      usdcMint,
      memberUsdcAta: ata(wallet, usdcMint),
      circleUsdcVault: ata(circle, usdcMint),
      usdcTokenProgram: SPL_TOKEN,
    })
    .instruction();
}

/**
 * A program refusal as the IDL names it, e.g. "AlreadyContributed: ...". Any
 * other failure is returned in its own words, never replaced with a guess.
 */
export function explainFailure(e: unknown): string {
  const text = [
    e instanceof Error ? e.message : String(e),
    ...((e as { logs?: string[] }).logs ?? []),
    String((e as { error?: unknown }).error ?? ""),
  ].join(" ");
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text)?.[1];
  const code = hex ? Number.parseInt(hex, 16) : Number(/"Custom":\s*(\d+)/.exec(text)?.[1] ?? Number.NaN);
  const err = (IDL.errors ?? []).find((x) => x.code === code);
  if (err) return `${err.name}${err.msg ? `: ${err.msg}` : ""}`;
  return e instanceof Error ? e.message : String(e);
}
