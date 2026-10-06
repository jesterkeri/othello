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

type Listed = {
  address: string;
  circle: Pick<DecodedCircle, "creator" | "members" | "n" | "circleId" | "status" | "round" | "joinedBitmap" | "paidBitmap" | "defaultedBitmap" | "withdrawnBitmap">;
};

/**
 * Where a circle sits in the list, lowest first, so the MAX_LISTED cap never drops one the wallet has something to do
 * in for one where it has nothing (adversary passes on 51bc786, 92b2ab7 and 092c768). A creator names the members and
 * picks the circle id without their consent, so an unjoined invitation never outranks a circle the wallet chose:
 *   0 something to do: Active and its seat unpaid (pay) or receiving this round (claim); finished and its seat owed
 *     and not collected (collect); Forming, created by it, every seat joined (start)
 *   1 Active, nothing to do this round
 *   2 Forming, joined or created by it, waiting for others
 *   3 Forming, an invitation it has not joined
 *   4 finished, nothing left for it
 * Claim is ranked whenever its seat receives this round: the cap is about not losing a circle, and the card itself
 * still says Claim only when the release would be accepted.
 */
export function listRank({ circle }: Listed, wallet: string): number {
  const turn = circle.members.slice(0, circle.n).findIndex((m) => m.toBase58() === wallet);
  const bit = (bitmap: number) => turn >= 0 && (bitmap & (1 << turn)) !== 0;
  const s = circle.status;
  if ("active" in s) {
    const pay = turn >= 0 && !bit(circle.paidBitmap) && !bit(circle.defaultedBitmap);
    return pay || (turn >= 0 && turn === circle.round) ? 0 : 1;
  }
  if ("completed" in s || "cancelled" in s) {
    const owed = turn >= 0 && ("completed" in s || bit(circle.joinedBitmap));
    return owed && !bit(circle.withdrawnBitmap) ? 0 : 4;
  }
  const creator = circle.creator.toBase58() === wallet;
  const full = circle.n > 0 && (circle.joinedBitmap & ((1 << circle.n) - 1)) === (1 << circle.n) - 1;
  if (creator && full) return 0;
  return bit(circle.joinedBitmap) || creator ? 2 : 3;
}

/** The circles in `accounts` that `wallet` created or holds a seat in, by listRank, then circle id, highest first. */
export function circlesOf(accounts: Listed[], wallet: string) {
  const id = (x: Listed) => BigInt(x.circle.circleId.toString());
  return accounts
    .filter(({ circle }) => circle.creator.toBase58() === wallet || circle.members.slice(0, circle.n).some((m) => m.toBase58() === wallet))
    .map((x) => ({ x, rank: listRank(x, wallet) }))
    .sort((a, b) => a.rank - b.rank || (id(b.x) > id(a.x) ? 1 : id(b.x) < id(a.x) ? -1 : 0))
    .map(({ x }) => x);
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
