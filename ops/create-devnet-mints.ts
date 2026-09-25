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
 *       ~/.config/solana/id.json, then tops the admin up to 20,000 test USDC
 *       for seeding the demo. Refuses any RPC that is not devnet. Safe to
 *       re-run: an existing mint is checked (owner, size, decimals, mint
 *       authority) and left; a stranger's pre-funded empty account is taken over.
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
  NFLXX_MIRROR_DECIMALS,
  NFLXX_MIRROR_SPACE,
  SPL_TOKEN,
  TEST_USDC_DECIMALS,
  TEST_USDC_SPACE,
  TOKEN_2022,
  ataAddress,
  createAtaIdempotentIx,
  createNflxxMirrorIxs,
  createTestUsdcIxs,
  devnetMintAddresses,
  mintToCheckedIx,
  standInState,
} from "./devnet-mints.ts";

const RECORD = resolve(import.meta.dirname, "devnet-mints.json");
const DEVNET = "https://api.devnet.solana.com";
const SEED_USDC = 20_000n * 1_000_000n;

type Record = { cluster: string; admin: string; nflxxMirror: string; testUsdc: string; createdAt?: string };

async function print(adminArg: string) {
  const admin = new anchor.web3.PublicKey(adminArg);
  const a = await devnetMintAddresses(admin);
  console.log(JSON.stringify({ cluster: "devnet", admin: admin.toBase58(), nflxxMirror: a.nflxxMirror.toBase58(), testUsdc: a.testUsdc.toBase58() }, null, 2));
}

/** `solana genesis-hash -u devnet`, 2026-09-25. Mainnet's is 5eykt4Us…; anything else is refused. */
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

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
  // S2 adversary: SOLANA_RPC could point anywhere. These are devnet stand-ins,
  // so refuse any cluster that is not devnet before a single lamport moves.
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`The RPC is not devnet (genesis ${genesis}, expected ${DEVNET_GENESIS}). Nothing was sent.`);
  }

  const [mirrorInfo, usdcInfo] = await connection.getMultipleAccountsInfo([a.nflxxMirror, a.testUsdc]);
  const mirror = standInState(mirrorInfo ?? null, { owner: TOKEN_2022, space: NFLXX_MIRROR_SPACE, decimals: NFLXX_MIRROR_DECIMALS, admin: admin.publicKey });
  const usdc = standInState(usdcInfo ?? null, { owner: SPL_TOKEN, space: TEST_USDC_SPACE, decimals: TEST_USDC_DECIMALS, admin: admin.publicKey });
  for (const [name, state] of [["NFLXx mirror", mirror], ["test USDC", usdc]] as const) {
    if (typeof state === "object") throw new Error(`The ${name} address holds an account that is not the expected mint: ${state.refused}. Nothing was sent.`);
  }

  // Each mint on its own, so a run that made one and not the other finishes.
  const ixs = [
    ...(mirror === "absent" ? await createNflxxMirrorIxs(admin.publicKey, await connection.getMinimumBalanceForRentExemption(NFLXX_MIRROR_SPACE)) : []),
    ...(usdc === "absent" ? await createTestUsdcIxs(admin.publicKey, await connection.getMinimumBalanceForRentExemption(TEST_USDC_SPACE)) : []),
  ];
  if (ixs.length) {
    const sig = await anchor.web3.sendAndConfirmTransaction(connection, new anchor.web3.Transaction().add(...ixs), [admin]);
    console.log(`Created ${[mirror === "absent" && "the NFLXx mirror", usdc === "absent" && "test USDC"].filter(Boolean).join(" and ")}: ${sig}`);
  } else {
    console.log("Both mints already exist with the expected owner, size, decimals and mint authority. Not re-created.");
  }

  // Top the admin up to 20,000 test USDC, never past it: a re-run does not mint more.
  const adminUsdc = ataAddress(a.testUsdc, admin.publicKey, SPL_TOKEN);
  const have = (await connection.getAccountInfo(adminUsdc))?.data.readBigUInt64LE(64) ?? 0n;
  if (have < SEED_USDC) {
    const sig = await anchor.web3.sendAndConfirmTransaction(
      connection,
      new anchor.web3.Transaction().add(
        createAtaIdempotentIx(admin.publicKey, admin.publicKey, a.testUsdc, SPL_TOKEN),
        mintToCheckedIx(a.testUsdc, adminUsdc, admin.publicKey, SEED_USDC - have, TEST_USDC_DECIMALS, SPL_TOKEN),
      ),
      [admin],
    );
    console.log(`Admin topped up to 20,000 test USDC for seeding: ${sig}`);
  }
  console.log(`NFLXx devnet mirror: ${a.nflxxMirror.toBase58()}`);
  console.log(`Othello test USDC:   ${a.testUsdc.toBase58()}`);
  writeFileSync(RECORD, JSON.stringify({ ...record, createdAt: record.createdAt ?? new Date().toISOString() }, null, 2) + "\n");
}

const [mode, arg] = process.argv.slice(2);
if (mode === "--print" && arg) await print(arg);
else if (mode === "--create") await create();
else {
  console.error("Usage: --print <ADMIN_PUBKEY> | --create");
  process.exit(1);
}
