/**
 * Creates the two devnet stand-in mints (S2). Joshua runs this; it signs with
 * his admin wallet and spends a little devnet SOL (two rent-exempt accounts,
 * about 0.005 SOL, plus fees).
 *
 *   pnpm tsx ops/create-devnet-mints.ts --print <ADMIN_PUBKEY>
 *       Prints both derived addresses. Reads no key, sends nothing.
 *
 *   pnpm tsx ops/create-devnet-mints.ts --create
 *       Creates both mints on devnet, signed by the wallet at $ANCHOR_WALLET or
 *       ~/.config/solana/id.json, then mints 20,000 test USDC to the admin for
 *       seeding the demo. Safe to re-run: an existing mint is checked and left.
 *
 * The program's devnet build must already contain these addresses
 * (programs/othello/src/allowlist.rs, feature "devnet"). --create refuses if
 * the addresses it derives differ from ops/devnet-mints.json, so a wrong
 * wallet cannot create mints the deployed program would not accept.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import {
  NFLXX_MIRROR_SPACE,
  SPL_TOKEN,
  TEST_USDC_DECIMALS,
  TEST_USDC_SPACE,
  TOKEN_2022,
  ataAddress,
  createAtaIdempotentIx,
  createDevnetMintsIxs,
  devnetMintAddresses,
  mintToCheckedIx,
} from "./devnet-mints.ts";

const RECORD = resolve(import.meta.dirname, "devnet-mints.json");
const DEVNET = "https://api.devnet.solana.com";
const SEED_USDC = 20_000n * 1_000_000n;

type Record = { cluster: string; admin: string; nflxxMirror: string; testUsdc: string };

async function print(adminArg: string) {
  const admin = new anchor.web3.PublicKey(adminArg);
  const a = await devnetMintAddresses(admin);
  console.log(JSON.stringify({ cluster: "devnet", admin: admin.toBase58(), nflxxMirror: a.nflxxMirror.toBase58(), testUsdc: a.testUsdc.toBase58() }, null, 2));
}

async function create() {
  const walletPath = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
  const admin = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as Record;
  const a = await devnetMintAddresses(admin.publicKey);

  if (record.admin !== admin.publicKey.toBase58() || record.nflxxMirror !== a.nflxxMirror.toBase58() || record.testUsdc !== a.testUsdc.toBase58()) {
    throw new Error(
      `This wallet (${admin.publicKey.toBase58()}) is not the admin recorded in ops/devnet-mints.json (${record.admin}). ` +
        "The program's devnet build only accepts the recorded addresses. Nothing was sent.",
    );
  }

  const connection = new anchor.web3.Connection(process.env.SOLANA_RPC ?? DEVNET, "confirmed");
  const existing = await connection.getMultipleAccountsInfo([a.nflxxMirror, a.testUsdc]);

  if (existing[0] || existing[1]) {
    // Re-run: check what is there rather than trusting it.
    if (!existing[0]?.owner.equals(TOKEN_2022) || existing[0].data.length !== NFLXX_MIRROR_SPACE) {
      throw new Error("An account exists at the NFLXx mirror address but is not the expected Token-2022 mint.");
    }
    if (!existing[1]?.owner.equals(SPL_TOKEN) || existing[1].data.length !== TEST_USDC_SPACE) {
      throw new Error("An account exists at the test USDC address but is not the expected SPL mint.");
    }
    console.log("Both mints already exist and have the expected owner and size. Not re-created.");
  } else {
    const ixs = await createDevnetMintsIxs(admin.publicKey, {
      nflxxMirror: await connection.getMinimumBalanceForRentExemption(NFLXX_MIRROR_SPACE),
      testUsdc: await connection.getMinimumBalanceForRentExemption(TEST_USDC_SPACE),
    });
    const sig = await anchor.web3.sendAndConfirmTransaction(connection, new anchor.web3.Transaction().add(...ixs), [admin]);
    console.log(`Created both mints: ${sig}`);
  }

  const sig = await anchor.web3.sendAndConfirmTransaction(
    connection,
    new anchor.web3.Transaction().add(
      createAtaIdempotentIx(admin.publicKey, admin.publicKey, a.testUsdc, SPL_TOKEN),
      mintToCheckedIx(a.testUsdc, ataAddress(a.testUsdc, admin.publicKey, SPL_TOKEN), admin.publicKey, SEED_USDC, TEST_USDC_DECIMALS, SPL_TOKEN),
    ),
    [admin],
  );
  console.log(`Minted 20,000 test USDC to the admin for seeding: ${sig}`);
  console.log(`NFLXx devnet mirror: ${a.nflxxMirror.toBase58()}`);
  console.log(`Othello test USDC:   ${a.testUsdc.toBase58()}`);
  writeFileSync(RECORD, JSON.stringify({ ...record, createdAt: new Date().toISOString() }, null, 2) + "\n");
}

const [mode, arg] = process.argv.slice(2);
if (mode === "--print" && arg) await print(arg);
else if (mode === "--create") await create();
else {
  console.error("Usage: --print <ADMIN_PUBKEY> | --create");
  process.exit(1);
}
