/**
 * Prints ONE demo member's secret key in base58, for Phantom's "Import
 * private key" (T25: Joshua pays his seat from the app, on camera).
 *
 *   pnpm tsx ops/export-member-key.ts --seat 2
 *
 * It is a secret, even though it holds only devnet test tokens. So this
 * refuses to run unless its output goes straight to a terminal: run it in
 * your OWN terminal, never with `!` in a Claude session (that output lands in
 * the conversation), and never paste what it prints anywhere but Phantom.
 */
import * as anchor from "@coral-xyz/anchor";

import { DEMO } from "./demo.ts";
import { demoMembers } from "./devnet-cli.ts";

const at = process.argv.indexOf("--seat");
const seat = Number(process.argv[at + 1]);
if (at === -1 || !Number.isInteger(seat) || seat < 1 || seat > DEMO.n) {
  console.error("Usage: pnpm tsx ops/export-member-key.ts --seat <1-5>");
  process.exit(1);
}
if (!process.stdout.isTTY) {
  console.error("Refused: stdout is not a terminal. Run this in your own terminal so the key is not captured or logged.");
  process.exit(1);
}

const member = demoMembers(DEMO.n)[seat - 1]!;
console.log(`Seat ${seat} address (public): ${member.publicKey.toBase58()}`);
console.log("Private key for Phantom > Add account > Import private key (devnet test funds only, do not share):");
console.log(anchor.utils.bytes.bs58.encode(member.secretKey));
