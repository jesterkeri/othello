/**
 * FR-10: schedules the demo's 10-for-1 split on the NFLXx devnet mirror, and
 * re-prices the feed for it in the same transaction. Joshua runs it DURING the
 * demo, after the seed (every member must have joined first: joining is
 * refused while the circle is Repricing).
 *
 *   pnpm tsx ops/schedule-split.ts --in <seconds>     (default 180)
 *
 * The split takes effect <seconds> after the chain's own clock reads now.
 */
import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";

import { scheduleSplit } from "./demo.ts";
import { DEMO_RECORD, devnetChain, writeDemoRecord } from "./devnet-cli.ts";

const args = process.argv.slice(2);
const i = args.indexOf("--in");
const seconds = i === -1 ? 180 : Number(args[i + 1]);
if (!Number.isInteger(seconds) || seconds < 30) {
  console.error("Usage: pnpm tsx ops/schedule-split.ts --in <seconds, 30 or more>");
  process.exit(1);
}

const { chain, mints } = await devnetChain();
const effectiveAt = (await chain.now()) + seconds;
// The circle the seed recorded; scheduleSplit refuses unless it is Active.
const { creator } = JSON.parse(readFileSync(DEMO_RECORD, "utf8")) as { creator: string };
await scheduleSplit(chain, mints, new anchor.web3.PublicKey(creator), effectiveAt);
writeDemoRecord({ splitEffectiveAt: effectiveAt, splitScheduledAt: new Date().toISOString() });
