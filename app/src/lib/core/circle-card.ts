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
        : card("active", isCreator(v, me) ? "Forming" : "Invited", `${isCreator(v, me) ? "Joining" : "You're invited: joining"} reopens once the ${v.collateral} price is updated`);
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
    // Until every seat has paid or been settled in default, the next step is that payment: the round's state shows.
    if (!v.seats.every((s) => s.paid || s.defaulted)) {
      return card("active", "Active", `Round ${v.round + 1} of ${v.n}: ${seatLabel(v.round)} receives ${fmt(pot)}`);
    }
    // Every seat is in. What still stands between the round and its release, by the chain's own stored figures (the
    // UI never computes the gate, SPEC.md payout gate):
    // - escrow short (RoundNotFunded): the escrow holds less than the defaulted seats' share of this round;
    // - Paused: the stored next_gate_short_by is more than the escrow deficit it includes (a deficit alone does not
    //   stop the gate; adversary on 4e64417);
    // - the price (Solana release_pot: set, fresh, not repricing; Robinhood has none).
    // A top-up first refills the escrow up to the deficit and only the rest reaches the reserve, and top_up_reserve
    // has no price check, so whenever the escrow or the gate is short the step is a top-up of the stored short_by
    // (never less than the escrow gap), named with its age, together with the price update when that is also
    // needed (SPEC.md copy: "Top up {short_by}"; adversary passes on af41248, dd59b76, ec145a5, 1417e60, 12cce85,
    // e8b9c40, 21ed54f and 7a9ded2). A seat settled in default cannot top up (AlreadyDefaulted).
    const settled = v.seats.filter((s) => s.defaulted && !s.paid).length;
    const escrowGap = BigInt(settled) * v.c - v.escrow;
    const gateShort = v.pausedShortBy > v.escrowDeficit;
    if (escrowGap > 0n || gateShort) {
      const shortBy = v.pausedShortBy > escrowGap ? v.pausedShortBy : escrowGap;
      const since = v.chainTime - v.pausedCheckedAt;
      const age = since < 60 ? "checked under a minute ago" : `checked ${span(since)} ago`;
      const why = escrowGap > 0n ? `Missed payments left the pot short (${age})` : `Payouts paused (${age})`;
      const band = escrowGap > 0n ? "Escrow short" : "Paused";
      const then = v.priceReady ? "" : `, then the pot can move once the ${v.collateral} price is updated`;
      if (turn === v.round) return card("needs", "Your move", `${why}: top up ${fmt(shortBy)}${then || " to release your pot"}`, "Top up");
      if (mine && !mine.defaulted) return card("active", band, `${why}: any member can top up ${fmt(shortBy)}${then}`, "Top up");
      return card("active", band, `${why}: ${fmt(shortBy)} short${then}`);
    }
    if (v.releasable && turn === v.round) return card("needs", "Your move", `Claim your ${fmt(pot)} pot`, "Claim");
    // anyone may release a funded round on both chains (releasePot / release_pot have no caller check): the card says
    // so, while the recipient's own Claim is what Needs-you counts (adversary on 60f4a3b)
    if (v.releasable) return card("active", "Funded", `Round ${v.round + 1} is funded: anyone can release ${fmt(pot)} to ${seatLabel(v.round)}`, "Release");
    if (!v.priceReady) return card("active", "Active", `Round ${v.round + 1} is paid: ${fmt(pot)} moves to ${seatLabel(v.round)} once the ${v.collateral} price is updated`);
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
