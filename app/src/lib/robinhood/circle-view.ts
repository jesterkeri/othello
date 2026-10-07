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
import { explorerTx } from "./chain";
import { fmtUsdg } from "./copy";
import { currentPhase as phaseFor, payoutSteps, type ChainWords, type CloseOut as CoreCloseOut, type FlowStep, type ReleaseButton, type ReleasePhase } from "../core/circle-page";
import { seatLabel, seatList } from "../core/ring";

// the payout and close-out shapes moved to lib/core/circle-page.ts (one circle page for both chains)
export type { FlowStep, ReleaseButton, ReleasePhase, StepStatus } from "../core/circle-page";

/** The Robinhood page's words for the shared panels. */
export const RH_WORDS: ChainWords = {
  fmt: fmtUsdg,
  txUrl: explorerTx,
  chain: "Robinhood Chain",
  locked: "USDG",
  testNote: "Test USDG only; it has no value.",
  payer: "contract",
};

// the ring moved to lib/core/ring.ts (one frontend for both chains); re-exported for the Robinhood page
export { ringOf, seatFill, seatLabel, seatList, seatSize, type Ring, type RingSeat, type RingSource, type SeatPayment, type SeatRole } from "../core/ring";

const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export type ReleaseContext = { hasWallet: boolean; connected: boolean; onRobinhood: boolean; busy: boolean; me: string | null };


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

/**
 * The six steps of a payout (lib/core/circle-page.ts payoutSteps) for a Robinhood circle: the contract refuses an
 * unfunded round with RoundNotFunded and the payout gate with CoverageTooLow or ReserveOvercommitted.
 */
export function releaseSteps(v: RhCircleView, phase: ReleasePhase): FlowStep[] {
  const error = phase.kind === "failed" ? phase.error : "";
  return payoutSteps({ n: v.n, round: v.round, seats: v.seats, gateShortBy: v.nextGateShortBy, checked: true }, phase, RH_WORDS, {
    coverRefused: ["CoverageTooLow", "ReserveOvercommitted"].includes(error),
    unfunded: error === "RoundNotFunded",
  });
}

/** A finished Robinhood circle: every amount exact (withdraw()'s own arithmetic) for a seat that has not collected. */
export type CloseOut = CoreCloseOut & {
  seats: (CoreCloseOut["seats"][number] & { amount: bigint })[];
  mine: (NonNullable<CoreCloseOut["mine"]> & { locked: bigint; pooled: bigint; total: bigint }) | null;
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
  return phaseFor(phase, v.round);
}
