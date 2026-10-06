/**
 * The Solana circles a wallet created or holds a seat in (Joshua 2026-10-06: the shared circles list scans the
 * program's circles on devnet; an index is a mainnet concern). Server-side only: called by /api/circles and
 * /api/circle, never by the browser, so a keyed DEVNET_RPC_URL never reaches it.
 *
 * A circle account stores every seat's wallet inline (programs/othello/src/state.rs, members: [Pubkey; 8]), so one
 * getProgramAccounts call filtered to the Circle discriminator finds them all; each match is then read in full with
 * readLiveCircle (Member accounts, price feed, mint).
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { DEMO_CIRCLE, DEMO_NAMES, NFLXX_MIRROR, PROGRAM_ID, REAL_XSTOCKS } from "./devnet";
import { accountsCoder, readLiveCircle, type DecodedCircle, type LiveCircle } from "./live";

/** readLiveCircle's own refusals are safe to show; anything from the RPC client is summarised (it could carry a key). */
export const OWN_ERROR = /^(No circle at|Missing |Seat \d|Member account|Expected \d|Unknown circle status|The circle's stock mint|Multiplier |.* is not an Othello account)/;

/** The most circles one wallet's list reads in full (the page shows three running at a time). */
export const MAX_LISTED = 12;

/** The stock's display word, from its mint: the devnet mirror says so, a real xStock its symbol. */
export function stockWord(mint: string): string {
  if (mint === NFLXX_MIRROR) return "NFLXx mirror";
  return REAL_XSTOCKS.find((x) => x.address === mint)?.symbol ?? "stock";
}

/** The demo circle keeps its cast's names; any other circle shows seat numbers. */
export const namesFor = (circle: string): readonly string[] => (circle === DEMO_CIRCLE ? DEMO_NAMES : []);

export { parseAddress } from "./sol-address";

/** The circles in `accounts` that `wallet` created or holds a seat in, newest-created first by circle id. */
export function circlesOf(accounts: { address: string; circle: Pick<DecodedCircle, "creator" | "members" | "n" | "circleId"> }[], wallet: string) {
  return accounts
    .filter(({ circle }) => circle.creator.toBase58() === wallet || circle.members.slice(0, circle.n).some((m) => m.toBase58() === wallet))
    .sort((a, b) => Number(BigInt(b.circle.circleId.toString()) - BigInt(a.circle.circleId.toString())));
}

/** Every Othello circle `wallet` created or holds a seat in, each read in full. */
export async function solanaCirclesOf(connection: Connection, wallet: string): Promise<LiveCircle[]> {
  const coder = accountsCoder();
  const filter = coder.memcmp("circle");
  const raw = await connection.getProgramAccounts(new PublicKey(PROGRAM_ID), {
    filters: [{ memcmp: { offset: filter.offset ?? 0, bytes: filter.bytes ?? "" } }],
  });
  const decoded = raw.flatMap(({ pubkey, account }) => {
    try {
      return [{ address: pubkey.toBase58(), circle: coder.decode<DecodedCircle>("circle", account.data) }];
    } catch {
      return [];
    }
  });
  const mine = circlesOf(decoded, wallet).slice(0, MAX_LISTED);
  return Promise.all(mine.map(({ address }) => readLiveCircle(connection, address, stockWord, namesFor(address))));
}
