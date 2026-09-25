/**
 * T24: seeds SPEC's demo circle on devnet, through activation. Joshua runs it.
 *
 *   pnpm tsx ops/seed-demo-circle.ts --cluster devnet
 *
 * Signs with the admin wallet ($ANCHOR_WALLET or ~/.config/solana/id.json) and
 * the five demo member keys in ~/.config/othello-demo/devnet/ (created on the
 * first run). Measured cost to the admin in bankrun: about 0.13 SOL.
 *
 * Safe to re-run: every step checks the chain first, so a run that stops half
 * way is finished by running it again, and a finished seed sends nothing.
 * The same steps are proven on the devnet build by tests/t24-seed-demo.spec.ts.
 *
 * Writes ops/demo-circle.json: public addresses only.
 */
import { DEMO, addresses, seedDemoCircle } from "./demo.ts";
import { existsSync } from "node:fs";

import { DEMO_RECORD, demoMembers, devnetChain, loadDemoMembers, writeDemoRecord } from "./devnet-cli.ts";

const [flag, cluster] = process.argv.slice(2);
if (flag !== "--cluster" || cluster !== "devnet") {
  console.error("Usage: pnpm tsx ops/seed-demo-circle.ts --cluster devnet");
  process.exit(1);
}

const { chain, mints } = await devnetChain();
// Codex T18 r1: once a circle is recorded, only its recorded member keys may
// seed it (load-only, refuses if missing); new keys are made only for the
// very first seed.
const members = existsSync(DEMO_RECORD) ? loadDemoMembers() : demoMembers(DEMO.n);
console.log(`Seeding the demo circle on devnet as ${chain.admin.publicKey.toBase58()}`);

const circle = await seedDemoCircle(chain, mints, members);
const a = addresses(chain.program, mints, members[0]!.publicKey);

writeDemoRecord({
  cluster: "devnet",
  program: chain.program.programId.toBase58(),
  circle: circle.toBase58(),
  circleId: DEMO.circleId.toString(),
  creator: members[0]!.publicKey.toBase58(),
  members: members.map((m) => m.publicKey.toBase58()),
  pool: a.pool.toBase58(),
  priceFeed: a.feed.toBase58(),
  stockMint: mints.stock.toBase58(),
  usdcMint: mints.usdc.toBase58(),
  seededAt: new Date().toISOString(),
});
console.log(`\nDemo circle: ${circle.toBase58()} (recorded in ops/demo-circle.json)`);
