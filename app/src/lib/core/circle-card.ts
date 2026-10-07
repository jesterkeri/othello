/**
 * One circle in the shared "Your circles" list (Joshua, 2026-10-06), on either chain: which group it sits in, what it
 * says, and the one next step for this wallet, from the chain-neutral ListCircle and the chain's time. Pure, so every
 * case is unit-tested (tests/a6-circle-card.spec.ts). The list only links to the circle page; every action happens
 * there.
 *
 * Rules both chains share (evm/src/OthelloCircle.sol, programs/othello): only the creator can start a circle, once
 * every seat has joined; seat i receives round i; a round's pot can be released once every seat has paid or been
 * settled in default (the chain's own further checks are in ListCircle.releasable); each member collects their own
 * seat from a finished circle.
 */
import { isCreator, mySeat, type ListCircle } from "./circle-list";
import { fmtMoney } from "./money";
import { seatLabel } from "./ring";

export type CardGroup = "needs" | "active" | "finished";
export type CircleCard = {
  group: CardGroup;
  /** The status band: "Your move", "Active", "Forming", "Finished", "Cancelled". */
  band: string;
  /** The next step for this wallet, or the circle's state when nothing is needed. */
  headline: string;
  /** Size and contribution, one line. */
  detail: string;
  /** This wallet's turn, in the right tense. */
  yourTurn: string;
  /** The button: always opens the circle page, where the action happens. */
  action: string;
};

export function circleCard(v: ListCircle, me: string): CircleCard {
  const fmt = (x: bigint) => fmtMoney(v.money, x);
  const mine = mySeat(v, me);
  const pot = BigInt(v.n) * v.c;
  const detail = `${v.n} members · ${fmt(v.c)} a round · ${fmt(pot)} pot`;
  const turn = mine?.turn ?? -1;
  const yourTurn = !mine ? "You are not a member of this circle"
    : v.status === "Cancelled" ? "Cancelled before it started"
    : v.status === "Completed" || mine.received ? `You received the pot in round ${turn + 1}`
    : v.status === "Active" && turn === v.round ? "You receive the pot this round"
    : `You receive the pot in round ${turn + 1}`;
  const card = (group: CardGroup, band: string, headline: string, action = "Open circle"): CircleCard =>
    ({ group, band, headline, detail, yourTurn, action });

  if (v.status === "Forming") {
    const joined = v.seats.filter((s) => s.joined).length;
    if (mine && !mine.joined) {
      // the chain refuses a join it cannot value (adversary on 4e64417): the invitation waits, not counted as a move
      return v.joinable
        ? card("needs", "Your move", `Join and lock your ${v.collateral}`, "Join")
        : card("active", "Invited", `You're invited: joining reopens once the ${v.collateral} price is updated`);
    }
    if (joined === v.n) {
      return isCreator(v, me)
        ? card("needs", "Your move", "Everyone has joined: start the circle", "Start")
        : card("active", "Forming", "Everyone has joined: waiting for the creator to start");
    }
    return card("active", "Forming", `Waiting for ${v.n - joined} of ${v.n} members to join`);
  }

  if (v.status === "Active") {
    if (mine && !mine.paid && !mine.defaulted) {
      const late = v.chainTime > v.deadline + v.graceSecs;
      return card("needs", "Your move", `Pay ${fmt(v.c)} for round ${v.round + 1}${late ? ": late" : ""}`, "Pay");
    }
    // paused at the chain's last coverage check (adversary on af41248: Claim was offered while releasePot reverted
    // ReserveOvercommitted): the list names the top-up instead; the circle page still lets anyone try the release.
    // The figure is as of that check, which adding collateral or a price move does not refresh, so its age is shown
    // (SPEC.md payout gate; adversary on dd59b76). It may include missed payments' escrow deficit, which top-ups fill
    // first, so it is "short", not "the reserve is short".
    // paused by the gate only when the stored figure is more than the escrow deficit it includes: a deficit alone
    // does not stop the release (releasePot / release_pot compare needs with the reserve; adversary on 4e64417)
    if (v.releasable && v.pausedShortBy > v.escrowDeficit) {
      const since = v.chainTime - v.pausedCheckedAt;
      const age = since < 60 ? "checked under a minute ago" : `checked ${span(since)} ago`;
      return turn === v.round
        ? card("needs", "Your move", `Payouts paused (${age}): top up ${fmt(v.pausedShortBy)} to release your pot`, "Top up")
        // a seat settled in default cannot top up (AlreadyDefaulted on both chains; adversary on ec145a5)
        : mine && !mine.defaulted
          ? card("active", "Paused", `Payouts paused (${age}): ${fmt(v.pausedShortBy)} short. Any member can top up`, "Top up")
          : card("active", "Paused", `Payouts paused (${age}): ${fmt(v.pausedShortBy)} short`);
    }
    if (v.releasable && turn === v.round) return card("needs", "Your move", `Claim your ${fmt(pot)} pot`, "Claim");
    // anyone may release a funded round on both chains (releasePot / release_pot have no caller check): the card says
    // so, while the recipient's own Claim is what Needs-you counts (adversary on 60f4a3b)
    if (v.releasable) return card("active", "Funded", `Round ${v.round + 1} is funded: anyone can release ${fmt(pot)} to ${seatLabel(v.round)}`, "Release");
    return card("active", "Active", `Round ${v.round + 1} of ${v.n}: ${seatLabel(v.round)} receives ${fmt(pot)}`);
  }

  // Completed or Cancelled: each member collects their own seat
  const close = v.closeOut;
  const cancelled = v.status === "Cancelled";
  const band = cancelled ? "Cancelled" : "Finished";
  const all = close ? `${close.collected} of ${close.owedCount} collected` : "";
  const owed = close?.mine?.owed ? close.mine : null;
  const what = owed?.amount != null ? fmt(owed.amount) : `locked ${v.collateral} and reserve share`;
  if (owed && !owed.collected) return card("needs", "Your move", `Collect your ${what}`, "Collect");
  if (owed && owed.collected) return card("finished", band, `You collected ${owed.amount != null ? what : "your share"} · ${all}`);
  return card("finished", band, cancelled ? `Cancelled · ${all}` : `All ${v.n} rounds paid out · ${all}`);
}

/** The three groups in page order, each with only the circles in it (empty groups are left out). */
export function groupCards<T extends { card: CircleCard }>(items: T[]): { group: CardGroup; title: string; items: T[] }[] {
  const titles: Record<CardGroup, string> = { needs: "Needs you", active: "Active", finished: "Finished" };
  return (["needs", "active", "finished"] as const)
    .map((group) => ({ group, title: titles[group], items: items.filter((x) => x.card.group === group) }))
    .filter((g) => g.items.length > 0);
}

/**
 * How long this round's payments stay open, by the chain's clock: "2d 4h", "5h 20m", "12m"; "Grace period" between the
 * deadline and the end of grace, "Late" after it. Null unless the circle is running.
 */
export function dueIn(v: Pick<ListCircle, "status" | "deadline" | "graceSecs" | "chainTime">): string | null {
  if (v.status !== "Active") return null;
  const left = v.deadline - v.chainTime;
  if (left <= 0) return v.chainTime > v.deadline + v.graceSecs ? "Late" : "Grace period";
  return span(left);
}

/** A length of time in words: "2d 4h", "3h 10m", "5m" (at least 1m). */
function span(seconds: number): string {
  const s = Math.max(0, seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}
