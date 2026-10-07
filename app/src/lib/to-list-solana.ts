/**
 * A Solana circle (LiveCircle, read by readLiveCircle on the server) as the shared circles list's ListCircle. Seats
 * come from the circle's bitmaps; amounts are USDC base units (6 dp). The two facts only this chain knows: whether the
 * pot can be released (releaseBlock, the same rule the Solana circle page uses) and who has collected from a finished
 * circle. The program's withdraw pays a member their stock, unused guarantee and top ups; the page does not compute
 * that amount yet, so the card names it in words (amount null).
 */
import { isRepricing, isStale, releaseBlock, seatSet } from "./circle";
import type { ListCircle } from "./core/circle-list";
import { USDC } from "./core/money";
import type { LiveCircle } from "./live";

const same = (a?: string | null, b?: string | null) => Boolean(a && b && a === b);
const big = (x: number) => BigInt(Math.trunc(x));

export function solToList(live: LiveCircle, me: string | null): ListCircle {
  const c = live.view;
  const seats = [...c.members].sort((a, b) => a.turn - b.turn).map((m) => ({
    turn: m.turn,
    wallet: m.address,
    joined: seatSet(c.joinedBitmap, m.turn),
    paid: seatSet(c.paidBitmap, m.turn),
    received: seatSet(c.receivedBitmap, m.turn),
    defaulted: seatSet(c.defaultedBitmap, m.turn),
    // the program records a missed payment only by declaring the seat in default
    marked: false,
    withdrawn: seatSet(c.withdrawnBitmap, m.turn),
  }));
  const finished = c.status === "Completed" || c.status === "Cancelled";
  // Completed: every seat collects; Cancelled: only the seats that joined (they locked stock)
  const owes = (s: (typeof seats)[number]) => c.status === "Completed" || s.joined;
  const mine = seats.find((s) => same(s.wallet, me)) ?? null;
  return {
    side: "solana",
    address: live.accounts.circle,
    href: `/circle/sol:${live.accounts.circle}`,
    creator: c.creator,
    n: c.n,
    c: big(c.contribution),
    status: c.status,
    round: c.round,
    deadline: c.roundDeadline,
    graceSecs: c.graceSecs,
    chainTime: live.readAt,
    escrow: big(c.escrow),
    reserveTotal: big(c.reserveTotal),
    reserveLosses: big(c.reserveLosses),
    seats,
    money: USDC,
    collateral: c.stockSymbol,
    releasable: releaseBlock(c, live.readAt) === null,
    pausedShortBy: big(c.nextGateShortBy),
    pausedCheckedAt: c.lastCoverageAt,
    escrowDeficit: big(c.escrowDeficit),
    // join_and_lock values the stock: it refuses an unset, stale or repricing price (SPEC.md join_and_lock)
    joinable: c.feed.wrapperPrice > 0 && c.feed.sharePrice > 0 && !isStale(c, live.readAt) && !isRepricing(c),
    closeOut: finished
      ? {
          collected: seats.filter((s) => owes(s) && s.withdrawn).length,
          owedCount: seats.filter(owes).length,
          mine: mine && { owed: owes(mine), collected: mine.withdrawn, amount: null },
        }
      : null,
  };
}
