/**
 * The circle ring both chains draw (Joshua 2026-10-06: one frontend, fed by each chain's adapter): every seat's role
 * and this round's payment, from a chain-neutral source (RingSource: the fields both chains' circles carry). Pure: no
 * wallet, no clock, no I/O (tests/a5-circle-view.spec.ts). Moved here from lib/robinhood/circle-view.ts, which
 * re-exports it unchanged for the Robinhood page.
 */

import { fmtUsdg } from "./money";

/** What the ring needs from a circle: the fields Robinhood's RhCircleView and the shared ListCircle both carry. */
export type RingSource = {
  n: number;
  /** One member's payment per round, in the chain's money base units. */
  c: bigint;
  status: "Forming" | "Active" | "Completed" | "Cancelled";
  round: number;
  deadline: number;
  graceSecs: number;
  /** The chain's time at the read. */
  chainTime: number;
  /** What the circle holds for defaulted seats' payments. */
  escrow: bigint;
  seats: { turn: number; wallet: string; joined: boolean; paid: boolean; received: boolean; defaulted: boolean; marked: boolean; withdrawn: boolean }[];
};

/** How amounts and the locked collateral are named: USDG on Robinhood (the default), USDC and the stock on Solana. */
export type RingWords = { fmt: (base: bigint) => string; collateral: string };


export type SeatRole = "receiving" | "received" | "upcoming" | "joined" | "open";
export type SeatPayment = "paid" | "covered" | "short" | "late" | "due" | null;

export type RingSeat = {
  turn: number;
  /** "Seat 1" for turn 0: seat N receives round N. */
  label: string;
  wallet: string;
  you: boolean;
  role: SeatRole;
  payment: SeatPayment;
  /** Plain words for the seat's state, read by screen readers and shown under the seat. */
  status: string;
  /** Where the seat sits on the ring, clockwise from the top, before the ring turns. */
  angle: number;
};

export type Ring = {
  n: number;
  seats: RingSeat[];
  /** The seat receiving this round (null unless the circle is active). */
  receiving: number | null;
  /** Degrees the ring turns so the receiving seat sits at the top: seat r's angle, undone. */
  rotation: number;
  /** One line under the pot. */
  caption: string;
};

/**
 * Whether two wallet addresses are the same: EVM addresses case-insensitively (checksum casing), anything else, such as
 * base58, exactly (adversary on b1cb461: a Solana seat naming the wallet's address with one letter's case changed was
 * drawn as the wallet's own).
 */
export const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && (a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b));
const same = sameAddress;
export const seatLabel = (turn: number) => `Seat ${turn + 1}`;

/** "Seat 2", "Seat 2 and Seat 3", "Seat 1, Seat 2 and Seat 4". */
export function seatList(turns: number[]): string {
  const l = turns.map(seatLabel);
  return l.length <= 1 ? (l[0] ?? "") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}

/**
 * `now` is chain time (the page's chainNow: the last block's time plus the seconds since that read); it defaults to
 * the read's own chain time. A seat is late once it is unpaid after deadline + grace, recorded or not.
 */
export function ringOf(v: RingSource, me?: string | null, now: number = v.chainTime,
  words: RingWords = { fmt: fmtUsdg, collateral: "USDG" }): Ring {
  const n = v.n;
  const step = 360 / n;
  const active = v.status === "Active";
  const finished = v.status === "Completed" || v.status === "Cancelled";
  const receiving = active ? v.round : null;
  const pot = BigInt(n) * v.c;
  const pastGrace = active && now > v.deadline + v.graceSecs;
  // defaulted seats' payments come from the escrow; it may not yet hold enough (RoundNotFunded)
  const coverOk = v.escrow >= BigInt(v.seats.filter((x) => x.defaulted && !x.paid).length) * v.c;
  const seats: RingSeat[] = v.seats.map((seat) => {
    const role: SeatRole =
      v.status === "Forming" || v.status === "Cancelled" ? (seat.joined ? "joined" : "open")
      : seat.received ? "received"
      : active && seat.turn === v.round ? "receiving"
      : "upcoming";
    const payment: SeatPayment = !active ? null
      : seat.paid ? "paid"
      : seat.defaulted ? (coverOk ? "covered" : "short")
      : seat.marked || pastGrace ? "late"
      : "due";
    const cancelled = v.status === "Cancelled";
    const roleWords = { receiving: "receives this round", received: "has received a pot", upcoming: `receives in round ${seat.turn + 1}`,
      joined: cancelled ? "joined before the circle was cancelled" : "joined", open: cancelled ? "did not join" : "not joined yet" }[role];
    const payWords = payment === null
      ? (finished && (v.status === "Completed" || seat.joined) ? (seat.withdrawn ? ", collected their share" : ", has not collected their share yet") : "")
      : { paid: ", paid this round", covered: `, settled in default: covered by locked ${words.collateral}`, short: ", settled in default: cover short", late: seat.marked ? ", late: payment recorded as missed" : ", late: unpaid after the grace period", due: ", payment due this round" }[payment];
    return {
      turn: seat.turn,
      label: seatLabel(seat.turn),
      wallet: seat.wallet,
      you: same(seat.wallet, me),
      role,
      payment,
      status: `${roleWords}${payWords}`,
      angle: seat.turn * step,
    };
  });
  const caption =
    v.status === "Forming" ? `${v.seats.filter((s) => s.joined).length} of ${n} seats joined`
    : active ? `Round ${v.round + 1} of ${n}: ${seatLabel(v.round)} receives ${words.fmt(pot)}`
    : v.status === "Completed" ? `All ${n} rounds paid out`
    : "This circle was cancelled";
  return { n, seats, receiving, rotation: receiving ? -receiving * step : 0, caption };
}


/**
 * Seat colours, never the hero's own: the hero is the palette's accent (--acid), so seats take the palette's other four
 * colours in turn, then white and black, and reuse them for larger circles (Joshua, 2026-10-05).
 */
const FILLS = [
  { fill: "var(--teal)", ink: "var(--tealInk)" },
  { fill: "var(--sky)", ink: "var(--skyInk)" },
  { fill: "var(--cobalt)", ink: "var(--cobaltInk)" },
  { fill: "var(--clay)", ink: "var(--clayInk)" },
  { fill: "#FBF9F2", ink: "#0B0B0B" },
  { fill: "#0B0B0B", ink: "#FBF9F2" },
] as const;
// seats 7 and 8 reuse sky and cobalt: a plain wrap would put seat 7 (teal) next to seat 1 (teal) in a circle of 7
export const seatFill = (turn: number) => FILLS[turn < FILLS.length ? turn : (turn - 5) % FILLS.length]!;

/**
 * A seat's diameter as a percentage of the ring: 20% up to four seats; from five, about 10% smaller for each seat
 * more, so eight never crowd (Joshua, 2026-10-05: "after 4 people ... the circles should start shrinking by percentage").
 */
export const seatSize = (n: number) => (n <= 4 ? 20 : 20 * 0.9 ** (n - 4));
