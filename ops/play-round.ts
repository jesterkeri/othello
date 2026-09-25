/**
 * T25: plays the demo circle's current round on devnet, for the video.
 *
 *   pnpm tsx ops/play-round.ts --skip 2      pay every unpaid seat except seat 2
 *                                            (the one you pay in the app, on camera)
 *   pnpm tsx ops/play-round.ts --release     release the pot to this round's seat
 *   pnpm tsx ops/play-round.ts --skip 2 --release
 *
 * Seats are 1-based, as on screen. Each member signs its own payment with its
 * key in ~/.config/othello-demo/devnet/; release_pot is sent by the admin.
 * Proven by tests/t25-demo-play.spec.ts on the devnet build.
 */
import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";

import { DEMO, payRound, releasePot } from "./demo.ts";
import { DEMO_RECORD, demoMembers, devnetChain } from "./devnet-cli.ts";

const args = process.argv.slice(2);
const skipAt = args.indexOf("--skip");
const skip = skipAt === -1 ? [] : String(args[skipAt + 1] ?? "").split(",").map((x) => Number(x) - 1);
const release = args.includes("--release");
if (skip.some((t) => !Number.isInteger(t) || t < 0 || t >= DEMO.n) || (skipAt === -1 && !release && args.length)) {
  console.error("Usage: pnpm tsx ops/play-round.ts [--skip <seat>[,<seat>]] [--release]");
  process.exit(1);
}

const { chain, mints } = await devnetChain();
const members = demoMembers(DEMO.n);
const record = JSON.parse(readFileSync(DEMO_RECORD, "utf8")) as { creator: string; members: string[] };
if (record.members.join() !== members.map((m) => m.publicKey.toBase58()).join()) {
  throw new Error("The member keys in ~/.config/othello-demo/devnet/ are not the members recorded in ops/demo-circle.json. Nothing was sent.");
}

if (skipAt !== -1 || !release) await payRound(chain, mints, members, skip);
if (release) await releasePot(chain, mints, new anchor.web3.PublicKey(record.creator));
