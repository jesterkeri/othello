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

/** Running (Forming or Active) before finished, so a cap never drops a circle the wallet may have to act in. */
const running = (status: Record<string, unknown>) => "forming" in status || "active" in status;

/**
 * The circles in `accounts` that `wallet` created or holds a seat in: running ones first, then by circle id, highest
 * first (adversary on 51bc786: a cap by id alone could drop a running circle).
 */
export function circlesOf(accounts: { address: string; circle: Pick<DecodedCircle, "creator" | "members" | "n" | "circleId" | "status"> }[], wallet: string) {
  const id = (x: (typeof accounts)[number]) => BigInt(x.circle.circleId.toString());
  return accounts
    .filter(({ circle }) => circle.creator.toBase58() === wallet || circle.members.slice(0, circle.n).some((m) => m.toBase58() === wallet))
    .sort((a, b) => Number(running(b.circle.status)) - Number(running(a.circle.status)) || (id(b) > id(a) ? 1 : id(b) < id(a) ? -1 : 0));
}

/** The Othello circles `wallet` created or holds a seat in, the first MAX_LISTED read in full, and how many it has. */
export async function solanaCirclesOf(connection: Connection, wallet: string): Promise<{ circles: LiveCircle[]; total: number }> {
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
  const all = circlesOf(decoded, wallet);
  const circles = await Promise.all(all.slice(0, MAX_LISTED).map(({ address }) => readLiveCircle(connection, address, stockWord, namesFor(address))));
  return { circles, total: all.length };
}
