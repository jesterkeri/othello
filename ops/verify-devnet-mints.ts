/**
 * Reads both devnet stand-in mints back from devnet and checks them (S2,
 * PREFLIGHT "mock mint has no transfer hook"). Read-only: no key, no signing.
 *
 *   pnpm tsx ops/verify-devnet-mints.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";
import { standInState, TOKEN_2022, SPL_TOKEN, NFLXX_MIRROR_SPACE, TEST_USDC_SPACE, NFLXX_MIRROR_DECIMALS, TEST_USDC_DECIMALS, ataAddress } from "./devnet-mints.ts";
const c = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
const record = JSON.parse(readFileSync(resolve(import.meta.dirname, "devnet-mints.json"), "utf8")) as { admin: string; nflxxMirror: string; testUsdc: string };
const admin = new anchor.web3.PublicKey(record.admin);
const mirror = new anchor.web3.PublicKey(record.nflxxMirror);
const usdc = new anchor.web3.PublicKey(record.testUsdc);
// Only the one extension, 56 bytes: no TransferHook, TransferFee, Pausable or delegate.
const onlyScaledUi = (d: Buffer) => d.length === 166 + 4 + 56;
const [m, u] = await c.getMultipleAccountsInfo([mirror, usdc]);
console.log("mirror:", standInState(m ?? null, { owner: TOKEN_2022, space: NFLXX_MIRROR_SPACE, decimals: NFLXX_MIRROR_DECIMALS, admin }));
console.log("usdc:  ", standInState(u ?? null, { owner: SPL_TOKEN, space: TEST_USDC_SPACE, decimals: TEST_USDC_DECIMALS, admin }));
const d = m!.data;
console.log("mirror only extension is ScaledUiAmount", onlyScaledUi(m!.data), "ext type", d.readUInt16LE(166), "len", d.readUInt16LE(168), "ext authority is admin", new anchor.web3.PublicKey(d.subarray(170, 202)).equals(admin), "multiplier", d.readDoubleLE(202), "freeze authority none", d.readUInt32LE(46) === 0);
console.log("usdc freeze authority none", u!.data.readUInt32LE(46) === 0, "supply", Number(u!.data.readBigUInt64LE(36)) / 1e6);
const ata = await c.getAccountInfo(ataAddress(usdc, admin, SPL_TOKEN));
console.log("admin test USDC", Number(ata!.data.readBigUInt64LE(64)) / 1e6);
console.log("admin SOL", (await c.getBalance(admin)) / 1e9);
