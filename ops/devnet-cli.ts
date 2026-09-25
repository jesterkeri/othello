/**
 * The devnet side of ops/demo.ts's Chain, shared by seed-demo-circle.ts and
 * schedule-split.ts. Every check here runs BEFORE anything is signed:
 *
 * - the RPC is devnet (genesis hash), whatever SOLANA_RPC says;
 * - the wallet is the admin recorded in ops/devnet-mints.json;
 * - the program at the IDL's address is deployed, and its upgrade authority
 *   is that admin, so the admin instructions will pass (T14's admin root).
 *
 * Demo member keypairs live OUTSIDE the repo, in ~/.config/othello-demo/devnet/
 * (directory 0700, files 0600). They hold only devnet test tokens, but they are
 * still keys: never committed, never printed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import type { Chain, Mints } from "./demo.ts";

const REPO = resolve(import.meta.dirname, "..");
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEMO_RECORD = resolve(import.meta.dirname, "demo-circle.json");
const MEMBER_DIR = resolve(homedir(), ".config/othello-demo/devnet");
const UPGRADEABLE_LOADER = new anchor.web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export async function devnetChain(): Promise<{ chain: Chain; mints: Mints; connection: anchor.web3.Connection }> {
  const record = JSON.parse(readFileSync(resolve(import.meta.dirname, "devnet-mints.json"), "utf8")) as {
    admin: string;
    nflxxMirror: string;
    testUsdc: string;
  };
  const walletPath = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
  const admin = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  if (admin.publicKey.toBase58() !== record.admin) {
    throw new Error(`This wallet (${admin.publicKey.toBase58()}) is not the devnet admin (${record.admin}). Nothing was sent.`);
  }

  const connection = new anchor.web3.Connection(process.env.SOLANA_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`The RPC is not devnet (genesis ${genesis}). Nothing was sent.`);

  const idl = JSON.parse(readFileSync(resolve(REPO, "target/idl/othello.json"), "utf8")) as anchor.Idl & { address: string };
  const programId = new anchor.web3.PublicKey(idl.address);
  const programData = anchor.web3.PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER)[0];
  const pd = await connection.getAccountInfo(programData);
  // ProgramData: tag 3 (u32), slot (u64), Option<Pubkey> authority at byte 12.
  if (!pd || pd.data.readUInt32LE(0) !== 3 || pd.data[12] !== 1 || !new anchor.web3.PublicKey(pd.data.subarray(13, 45)).equals(admin.publicKey)) {
    throw new Error(`Othello is not deployed at ${programId.toBase58()} with ${record.admin} as its upgrade authority. Nothing was sent.`);
  }

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  const chain: Chain = {
    program,
    admin,
    send: async (ixs, signers) => {
      const sig = await anchor.web3.sendAndConfirmTransaction(connection, new anchor.web3.Transaction().add(...ixs), signers, {
        commitment: "confirmed",
      });
      console.log(`  tx ${sig}`);
    },
    getAccount: async (address) => {
      const info = await connection.getAccountInfo(address);
      return info ? { lamports: info.lamports, data: info.data, owner: info.owner } : null;
    },
    now: async () => {
      const t = await connection.getBlockTime(await connection.getSlot());
      if (t === null) throw new Error("devnet returned no block time; try again");
      return t;
    },
    log: (line) => console.log(line),
  };

  return {
    chain,
    mints: { stock: new anchor.web3.PublicKey(record.nflxxMirror), usdc: new anchor.web3.PublicKey(record.testUsdc) },
    connection,
  };
}

/** Loads the n demo member keypairs, creating any that are missing. Never prints a secret. */
export function demoMembers(n: number): anchor.web3.Keypair[] {
  mkdirSync(MEMBER_DIR, { recursive: true, mode: 0o700 });
  chmodSync(MEMBER_DIR, 0o700);
  return Array.from({ length: n }, (_, i) => {
    const path = resolve(MEMBER_DIR, `member-${i + 1}.json`);
    if (!existsSync(path)) {
      const k = anchor.web3.Keypair.generate();
      writeFileSync(path, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
    }
    chmodSync(path, 0o600);
    return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  });
}

export function writeDemoRecord(update: Record<string, unknown>): void {
  const current = existsSync(DEMO_RECORD) ? (JSON.parse(readFileSync(DEMO_RECORD, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(DEMO_RECORD, JSON.stringify({ ...current, ...update }, null, 2) + "\n");
}
