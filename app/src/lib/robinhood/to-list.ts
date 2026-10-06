/**
 * A Robinhood circle (RhCircleView, read by readCircle) as the shared circles list's ListCircle. The two facts only
 * this chain knows come from the Robinhood page's own rules: whether the pot can be released (releaseButton, with
 * every wallet condition met, so only the chain's state decides) and what each member collects (closeOutOf, exact).
 */
import type { ListCircle } from "../core/circle-list";
import { USDG } from "../core/money";
import type { RhCircleView } from "./adapter";
import { closeOutOf, releaseButton } from "./circle-view";

export function rhToList(v: RhCircleView, me: string | null): ListCircle {
  const release = releaseButton(v, { hasWallet: true, connected: true, onRobinhood: true, busy: false, me });
  const close = closeOutOf(v, me);
  return {
    side: "robinhood", address: v.address, href: `/circle/rh:${v.address}`, creator: v.creator,
    n: v.n, c: v.c, status: v.status, round: v.round, deadline: v.deadline, graceSecs: v.graceSecs, chainTime: v.chainTime,
    escrow: v.escrow, reserveTotal: v.reserveTotal, reserveLosses: v.reserveLosses, seats: v.seats, money: USDG, collateral: "USDG",
    releasable: Boolean(release?.enabled),
    pausedShortBy: v.nextGateShortBy,
    pausedCheckedAt: v.lastCoverageAt,
    closeOut: close && {
      collected: close.collected, owedCount: close.owedCount,
      mine: close.mine && { owed: close.mine.owed, collected: close.mine.collected, amount: close.mine.total },
    },
  };
}
