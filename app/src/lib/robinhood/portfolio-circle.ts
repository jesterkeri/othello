/**
 * The "Your circle" card on the Robinhood portfolio (Joshua, 2026-10-06: the same card as the Solana portfolio's).
 * Pure: it takes circle reads (RhCircleView, from readCircle) and the connected wallet, and returns which circle the
 * card shows and what it says, so the choice is unit-tested without a chain (tests/robinhood-portfolio-circle.spec.ts).
 *
 * Which circle: only running ones (status Active) where this wallet holds a seat. One where the wallet must act comes
 * first (its seat has neither paid this round nor been settled in default); among several, the one whose round ends
 * soonest. With none to act on, the most recent running circle (reads arrive newest first, as listMyCircles returns
 * them). With no running circle, null: the page says so.
 *
 * "You owe" is the contract's own figure (evm/src/OthelloCircle.sol: a seat that has received the pot owes
 * c x (n - roundsPaid); one that has not owes nothing yet), the same rule as the Solana card's obligations().
 */
import type { RhCircleView, RhSeat } from "./adapter";
import { fmtUsdg } from "./copy";

const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** The wallet's seat in this circle, or null. */
export const seatOf = (v: RhCircleView, me?: string | null): RhSeat | null => v.seats.find((s) => same(s.wallet, me)) ?? null;

/** True when the circle is running and the wallet's seat still has to pay this round. */
export function mustAct(v: RhCircleView, me?: string | null): boolean {
  const seat = seatOf(v, me);
  return v.status === "Active" && !!seat && seat.joined && !seat.paid && !seat.defaulted;
}

/** The circle the card shows, from reads given newest first; null when none is running with this wallet in it. */
export function pickCircle(views: readonly RhCircleView[], me?: string | null): RhCircleView | null {
  const running = views.filter((v) => v.status === "Active" && seatOf(v, me));
  const acting = running.filter((v) => mustAct(v, me));
  // the earliest deadline wins; on a tie the newer circle (earlier in the list) stays
  if (acting.length) return acting.reduce((best, v) => (v.deadline < best.deadline ? v : best));
  return running[0] ?? null;
}

export type CardPip = { key: string; title: string; mine: boolean; got: boolean };
export type CardFact = { label: string; value: string; title?: string };
export type CircleCard = {
  href: string;
  headline: string;
  sub: string;
  mustAct: boolean;
  pips: CardPip[];
  facts: CardFact[];
};

/** What the card says for circle `v` and the wallet `me` (its seat must be in `v`; null otherwise). */
export function circleCard(v: RhCircleView, me?: string | null): CircleCard | null {
  const seat = seatOf(v, me);
  if (!seat) return null;
  const active = v.status === "Active";
  // late: unpaid after the round's deadline plus grace, by chain time (as the circle page decides it)
  const late = active && !seat.paid && !seat.defaulted && (seat.marked || v.chainTime > v.deadline + v.graceSecs);
  const roundState = seat.paid ? "paid" : seat.defaulted ? "settled in default" : late ? "late" : "due";
  const pot = seat.received ? "you have received your pot" : active && v.round === seat.turn ? "your pot is this round" : `your pot is round ${seat.turn + 1}`;
  const owe = seat.received ? v.c * BigInt(v.n - seat.roundsPaid) : 0n;
  return {
    href: `/circle/rh:${v.address}`,
    headline: active ? `Round ${v.round + 1} of ${v.n}` : v.status,
    sub: `Seat ${seat.turn + 1} · ${pot}`,
    mustAct: mustAct(v, me),
    pips: v.seats.map((s) => ({
      key: String(s.turn),
      title: `Round ${s.turn + 1}: Seat ${s.turn + 1}${s.received ? ", paid out" : ""}`,
      mine: s.turn === seat.turn,
      got: s.received,
    })),
    facts: [
      { label: "Locked", value: fmtUsdg(seat.collateral) },
      ...(active ? [{ label: `Round ${v.round + 1}`, value: roundState }] : []),
      { label: "Guarantee", value: fmtUsdg(seat.g) },
      {
        label: "You owe",
        value: fmtUsdg(owe),
        title: "After you receive the pot, the payments for the rounds left. Nothing before then.",
      },
    ],
  };
}
