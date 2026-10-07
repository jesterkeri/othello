/**
 * What the Robinhood circle page draws, derived only from the circle's live onchain state (RhCircleView, read by
 * readCircle) and the connected wallet. Pure: no wallet, no clock, no I/O, so every mapping is unit-tested
 * (tests/a5-circle-view.spec.ts).
 *
 * The contract (evm/src/OthelloCircle.sol releasePot): any address may release a round's pot; seat i receives round i;
 * it refuses (RoundNotFunded) while a seat has neither paid nor been settled in default, or while the escrow cannot
 * cover the defaulted seats' payments, and (CoverageTooLow, ReserveOvercommitted) when the reserve would not cover
 * the next rounds. It recomputes that last check itself, so the stored nextGateShortBy is shown as the last check's
 * result, not treated as a refusal.
 */
import type { RhCircleView } from "./adapter";
import { fmtUsdg } from "./copy";
import { seatLabel, seatList } from "../core/ring";

// the ring moved to lib/core/ring.ts (one frontend for both chains); re-exported for the Robinhood page
export { ringOf, seatFill, seatLabel, seatList, seatSize, type Ring, type RingSeat, type RingSource, type SeatPayment, type SeatRole } from "../core/ring";

const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export type ReleaseContext = { hasWallet: boolean; connected: boolean; onRobinhood: boolean; busy: boolean; me: string | null };
export type ReleaseButton = { label: string; enabled: boolean; blocker: string | null; recipientTurn: number; amount: bigint };


/** The pay-out control, or null when the circle is not active. Its label says truly who receives. */
export function releaseButton(v: RhCircleView, ctx: ReleaseContext): ReleaseButton | null {
  if (v.status !== "Active") return null;
  const recipientTurn = v.round;
  const amount = BigInt(v.n) * v.c;
  const mine = same(v.seats[recipientTurn]?.wallet, ctx.me);
  const label = mine ? `Claim your ${fmtUsdg(amount)} pot` : `Release ${fmtUsdg(amount)} to ${seatLabel(recipientTurn)}`;
  const blocked = (blocker: string): ReleaseButton => ({ label, enabled: false, blocker, recipientTurn, amount });
  if (!ctx.hasWallet) return blocked("Install MetaMask or another EVM wallet to release the pot.");
  if (!ctx.connected) return blocked("Connect an EVM wallet to release the pot.");
  if (!ctx.onRobinhood) return blocked("Switch your wallet to Robinhood Chain testnet to release the pot.");
  if (ctx.busy) return blocked("A transaction is already waiting for your wallet or for Robinhood Chain.");
  const unpaid = v.seats.filter((s) => !s.paid && !s.defaulted).map((s) => s.turn);
  if (unpaid.length) return blocked(`Waiting for ${seatList(unpaid)} to pay this round.`);
  const covered = v.seats.filter((s) => s.defaulted && !s.paid).length;
  const need = BigInt(covered) * v.c;
  if (v.escrow < need) return blocked(`Missed payments need ${fmtUsdg(need - v.escrow)} more cover before the pot can move. Any member can top up.`);
  return { label, enabled: true, blocker: null, recipientTurn, amount };
}

/** Where a release stands. "sent" carries the hash from the wallet; "released" the confirmed receipt's. */
export type ReleasePhase =
  | { kind: "idle" }
  | { kind: "wallet" }
  | { kind: "sent"; hash: string }
  | { kind: "released"; hash: string; round: number; recipientTurn: number; amount: bigint }
  /** A refusal belongs to the round it was tried in; once the read has moved on it no longer applies. */
  | { kind: "failed"; message: string; error: string; round: number };

export type StepStatus = "done" | "now" | "todo" | "blocked";
export type FlowStep = { key: string; label: string; status: StepStatus; detail: string };

/**
 * The six steps of a payout, each from real state: payments and the reserve from the chain read, the wallet and
 * pending steps from the action in flight, "released" from a successful receipt, "confirmed" only once a fresh read
 * shows the recipient's seat as received. Nothing is marked done before the chain says so.
 */
export function releaseSteps(v: RhCircleView, phase: ReleasePhase): FlowStep[] {
  const done = phase.kind === "released";
  // the round this flow is about: once released, the read may already show the next round
  const round = done ? phase.round : v.round;
  const unpaid = v.seats.filter((s) => !s.paid && !s.defaulted).map((s) => s.turn);
  const settled = done || unpaid.length === 0;
  const paidCount = v.seats.filter((s) => s.paid || s.defaulted).length;
  const reserveShort = v.nextGateShortBy;
  const coverFailed = phase.kind === "failed" && ["CoverageTooLow", "ReserveOvercommitted"].includes(phase.error);
  const confirmed = done && Boolean(v.seats[phase.recipientTurn]?.received);
  const inFlight = phase.kind === "wallet" || phase.kind === "sent";
  const failedAt = phase.kind === "failed" && !coverFailed && phase.error !== "RoundNotFunded";
  return [
    { key: "payments", label: "Payments", status: settled ? "done" : "blocked",
      detail: settled ? `Every seat has paid or been settled for round ${round + 1}` : `${paidCount} of ${v.n} paid; waiting for ${seatList(unpaid)}` },
    { key: "safety", label: "Payout safety", status: coverFailed ? "blocked" : done || inFlight ? "done" : reserveShort > 0n ? "blocked" : settled ? "done" : "todo",
      detail: coverFailed ? "The reserve would not cover the next rounds. Top up the reserve, then check payout safety."
        : reserveShort > 0n && !done && !inFlight ? `Last check found the reserve ${fmtUsdg(reserveShort)} short. Releasing checks it again.`
        : "The reserve covers the next rounds" },
    { key: "wallet", label: "Wallet confirmation", status: phase.kind === "wallet" ? "now" : phase.kind === "sent" || done ? "done" : failedAt ? "blocked" : "todo",
      detail: phase.kind === "wallet" ? "Confirm the release in your wallet" : failedAt ? (phase as { message: string }).message : "Your wallet asks you to confirm" },
    { key: "pending", label: "Pending on chain", status: phase.kind === "sent" ? "now" : done ? "done" : "todo",
      detail: phase.kind === "sent" ? "Sent. Waiting for Robinhood Chain to include it" : "Robinhood Chain includes the transaction" },
    { key: "released", label: "Pot released", status: done ? "done" : "todo",
      detail: done ? `${fmtUsdg(phase.amount)} left the pot in a successful transaction` : "The contract pays the pot" },
    { key: "confirmed", label: "Confirmed", status: confirmed ? "done" : done ? "now" : "todo",
      detail: confirmed ? `${seatLabel(phase.recipientTurn)} received ${fmtUsdg(phase.amount)}` : done ? "Reading the circle again to confirm" : "The circle shows the recipient as paid" },
  ];
}

export type CloseOut = {
  title: string;
  body: string;
  seats: { turn: number; label: string; wallet: string; you: boolean; collected: boolean; owed: boolean; amount: bigint }[];
  collected: number;
  owedCount: number;
  /** The connected member's seat and exactly what withdraw() pays it: its locked USDG plus its reserve share. */
  mine: { turn: number; collected: boolean; owed: boolean; locked: bigint; pooled: bigint; total: bigint } | null;
};

/**
 * A finished circle (evm/src/OthelloCircle.sol withdraw): each member calls withdraw() for their own seat, paid to
 * their own wallet, with no deadline. Completed: their locked USDG plus a share of what is left in the shared
 * reserve. Cancelled: joined members get their locked USDG, guarantee and top ups back; unjoined seats are owed nothing.
 * Nobody can collect for another member in this contract version.
 */
export function closeOutOf(v: RhCircleView, me?: string | null): CloseOut | null {
  if (v.status !== "Completed" && v.status !== "Cancelled") return null;
  const completed = v.status === "Completed";
  // withdraw()'s own arithmetic (CircleMath.pooledShare, floor). The pool inputs do not change once the circle is
  // finished, but withdraw() sets the seat's collateral to 0: an amount is exact only for a seat that has not
  // collected yet. For a collected seat it is what is left, not what was paid (adversary on 67d3214).
  const poolLeft = v.reserveTotal - v.reserveLosses + v.escrow;
  const denom = v.depositsTotal - v.forfeitedTotal;
  const pays = (seat: RhCircleView["seats"][number]) => {
    const pooled = !completed ? seat.g + seat.topUps
      : denom === 0n ? 0n : (poolLeft * (seat.g + seat.topUps - seat.forfeited)) / denom;
    return { locked: seat.collateral, pooled, total: seat.collateral + pooled };
  };
  const seats = v.seats.map((seat) => ({
    turn: seat.turn, label: seatLabel(seat.turn), wallet: seat.wallet, you: same(seat.wallet, me),
    collected: seat.withdrawn, owed: completed || seat.joined, amount: pays(seat).total,
  }));
  const owed = seats.filter((x) => x.owed);
  const collected = owed.filter((x) => x.collected).length;
  const mineSeat = v.seats.find((seat) => same(seat.wallet, me));
  const mine = mineSeat ? { turn: mineSeat.turn, collected: mineSeat.withdrawn, owed: completed || mineSeat.joined, ...pays(mineSeat) } : null;
  return {
    title: completed ? `All ${v.n} rounds are paid out` : "This circle was cancelled",
    body: completed
      ? "Each member now collects their own locked USDG plus a share of what is left in the shared reserve. Only the member's own wallet can collect it, and it does not expire."
      : "It was cancelled before it started. Each member who joined collects their locked USDG, guarantee and any top ups back. Only the member's own wallet can collect it, and it does not expire.",
    seats, collected, owedCount: owed.length, mine,
  };
}

/** The phase to show for this read: a failure from an earlier round does not carry into the next (spec: no lingering). */
export function currentPhase(phase: ReleasePhase, v: RhCircleView): ReleasePhase {
  return phase.kind === "failed" && phase.round !== v.round ? { kind: "idle" } : phase;
}
