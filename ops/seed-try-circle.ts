/**
 * PR #29's devnet try: a forming circle with Joshua's own wallet in its last seat, so he can try Join, Leave and Join
 * again from the app. Joshua runs it.
 *
 *   pnpm tsx ops/seed-try-circle.ts --cluster devnet --wallet <your devnet wallet address>
 *
 * SPEC's demo parameters, 5 seats: seats 1 to 4 are script-held keys (in ~/.config/othello-demo/devnet-try/, made on
 * the first run) and join with 1.1 NFLXx mirror each; seat 1 created it. Seat 5 is your wallet, given 0.02 SOL (only
 * if it holds less), 1.1 NFLXx mirror and the test USDC a seat owes, and left open. The circle stays Forming.
 *
 * Uses the demo's price feed and pool as they are and never changes them, so the demo circle is untouched. Refuses
 * before sending anything if the price would go stale within the hour (run ops/touch-prices.ts first). Signs with the
 * admin wallet ($ANCHOR_WALLET or ~/.config/solana/id.json) and the script-held keys. Safe to re-run.
 * Proven on the devnet build by tests/b2-devnet-try.spec.ts.
 *
 * Writes ops/try-circle.json: public addresses only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";

import { DEMO, seedTryCircle } from "./demo.ts";
import { DEMO_RECORD, TRY_RECORD, devnetChain, tryCircleKeys } from "./devnet-cli.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--wallet");
let wallet: anchor.web3.PublicKey | null = null;
try {
  wallet = at === -1 ? null : new anchor.web3.PublicKey(args[at + 1] ?? "");
} catch {
  wallet = null;
}
if (args[0] !== "--cluster" || args[1] !== "devnet" || !wallet) {
  console.error("Usage: pnpm tsx ops/seed-try-circle.ts --cluster devnet --wallet <your devnet wallet address>");
  process.exit(1);
}
// The try seat is a person's own wallet, never one of the demo circle's script-held seats.
if (existsSync(DEMO_RECORD) && (JSON.parse(readFileSync(DEMO_RECORD, "utf8")) as { members: string[] }).members.includes(wallet.toBase58())) {
  console.error(`${wallet.toBase58()} is a seat of the demo circle (ops/demo-circle.json): the try seat must be your own wallet. Nothing was sent.`);
  process.exit(1);
}
if (existsSync(TRY_RECORD)) {
  const recorded = (JSON.parse(readFileSync(TRY_RECORD, "utf8")) as { members: string[] }).members[DEMO.n - 1];
  if (recorded !== wallet.toBase58()) {
    console.error(`${TRY_RECORD} records the try circle for wallet ${recorded}, not ${wallet.toBase58()}. Nothing was sent.`);
    process.exit(1);
  }
}

const { chain, mints } = await devnetChain();
const scripted = tryCircleKeys(DEMO.n - 1);
console.log(`Seeding a try circle on devnet as ${chain.admin.publicKey.toBase58()}, seat ${DEMO.n} for ${wallet.toBase58()}`);
const circle = await seedTryCircle(chain, mints, scripted, wallet);

writeFileSync(
  TRY_RECORD,
  JSON.stringify(
    {
      cluster: "devnet",
      program: chain.program.programId.toBase58(),
      circle: circle.toBase58(),
      creator: scripted[0]!.publicKey.toBase58(),
      members: [...scripted.map((k) => k.publicKey.toBase58()), wallet.toBase58()],
      seededAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nTry circle: ${circle.toBase58()} (recorded in ops/try-circle.json). Connect ${wallet.toBase58()} on the preview and open it.`);
