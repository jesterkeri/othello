/**
 * The shared single-circle page (Joshua 2026-10-07: one page for both chains, the Robinhood page's layout made
 * chain-neutral). What the page's payout and close-out panels show, from each chain's own read, in that chain's own
 * words. Pure: no wallet, no clock, no I/O.
 *
 * Both chains' release refuses while a seat has neither paid nor been settled in default, or while the escrow cannot
 * pay the defaulted seats' share of the round; the payout gate is re-checked by the release itself, so the stored
 * "short by" figure is shown as the last check's result, never as a refusal (SPEC.md payout gate).
 */
import { seatLabel, seatList } from "./ring";

/** The words and links a chain's page uses. */
export type ChainWords = {
  /** Money in this chain's unit, e.g. "10 USDG", "10 USDC". */
  fmt: (base: bigint) => string;
  /** The explorer page of a transaction. */
  txUrl: (hash: string) => string;
  /** "Robinhood Chain", "Solana devnet". */
  chain: string;
  /** What a seat locks, e.g. "USDG", "NFLXx devnet mirror". */
  locked: string;
  /** The closing note on every money panel, e.g. "Test USDG only; it has no value." */
  testNote: string;
  /** What pays out on chain: "contract" (Robinhood), "program" (Solana). */
  payer: string;
};

export type ReleaseButton = { label: string; enabled: boolean; blocker: string | null; recipientTurn: number; amount: bigint };

/** Where a release stands. "sent" carries the hash from the wallet; "released" the confirmed receipt's. */
export type ReleasePhase =
  | { kind: "idle" }
  | { kind: "wallet" }
  | { kind: "sent"; hash: string }
  | { kind: "released"; hash: string; round: number; recipientTurn: number; amount: bigint }
  /** A refusal belongs to the round it was tried in; once the read has moved on it no longer applies. */
  | { kind: "failed"; message: string; error: string; round: number; hash?: string };

export type StepStatus = "done" | "now" | "todo" | "blocked";
export type FlowStep = { key: string; label: string; status: StepStatus; detail: string };

/** What the payout steps read from a circle, on either chain. */
export type PayoutInput = {
  n: number;
  round: number;
  seats: readonly { turn: number; paid: boolean; defaulted: boolean; received: boolean }[];
  /** The stored "short by" of the last coverage check (0 when the gate passed). */
  gateShortBy: bigint;
  /** Whether any coverage check has run (Solana: last_coverage_at > 0; until then the stored figure is just 0). */
  checked: boolean;
  /**
   * The circle has completed: its last pot is paid out, so every seat paid or was settled in default for the last
   * round, whatever the read's paid flags say (Solana's last release_pot clears paid_bitmap without moving the round).
   */
  finished?: boolean;
};

/**
 * The six steps of a payout, each from real state: payments and the reserve from the chain read, the wallet and
 * pending steps from the action in flight, "released" from a successful receipt, "confirmed" only once a fresh read
 * shows the recipient's seat as received. Nothing is marked done before the chain says so. `coverRefused` says the
 * failed release was the payout gate's refusal (Robinhood CoverageTooLow / ReserveOvercommitted, Solana
 * coverage_too_low / reserve_overcommitted); `unfunded` that it was the round not yet funded.
 */
export function payoutSteps(v: PayoutInput, phase: ReleasePhase, words: ChainWords, refusal: { coverRefused: boolean; unfunded: boolean }): FlowStep[] {
  const done = phase.kind === "released";
  const over = done || Boolean(v.finished);
  // the round this flow is about: once released, the read may already show the next round
  const round = done ? phase.round : v.round;
  const unpaid = v.seats.filter((s) => !s.paid && !s.defaulted).map((s) => s.turn);
  const settled = over || unpaid.length === 0;
  const paidCount = v.seats.filter((s) => s.paid).length;
  const coveredCount = over ? 0 : v.seats.filter((s) => s.defaulted && !s.paid).length;
  const reserveShort = v.gateShortBy;
  const coverFailed = phase.kind === "failed" && refusal.coverRefused;
  const confirmed = done && Boolean(v.seats.find((s) => s.turn === phase.recipientTurn)?.received);
  const inFlight = phase.kind === "wallet" || phase.kind === "sent";
  const failedAt = phase.kind === "failed" && !coverFailed && !refusal.unfunded;
  const { fmt, chain } = words;
  return [
    { key: "payments", label: "Payments", status: settled ? "done" : "blocked",
      // exact about a seat settled in default: its share is paid from the escrow by the release itself, so it has not
      // "paid" (T18d adversary)
      // once released the read has moved to the next round and no longer says who paid the released one, so the step
      // names both ways a seat is in (adversary on fd9d764)
      detail: over ? `Every seat paid or was settled in default for round ${round + 1}`
        // a seat in default is counted as settled, never as paid (adversary on af399a9)
        : !settled ? `${paidCount} of ${v.n} paid${coveredCount > 0 ? `, ${coveredCount} settled in default` : ""}; waiting for ${seatList(unpaid)}`
        : coveredCount > 0 ? `Every seat is in for round ${round + 1}: ${v.n - coveredCount} paid, ${coveredCount} settled in default`
        : `Every seat has paid round ${round + 1}` },
    // ticked only once the chain has said so: a release in the wallet or on its way has not been checked yet (the
    // release itself checks the reserve again), and a circle never checked has no figure to trust (adversary on
    // 74ce48b)
    { key: "safety", label: "Payout safety",
      status: coverFailed ? "blocked" : done ? "done" : phase.kind === "sent" ? "now" : phase.kind === "wallet" ? "todo" : reserveShort > 0n ? "blocked" : !v.checked ? "todo" : settled ? "done" : "todo",
      detail: coverFailed ? "The reserve would not cover the next rounds. Top up the reserve, then check payout safety."
        : done ? "The reserve covered the next rounds when the pot was released"
        : inFlight ? `${reserveShort > 0n ? `Last check found the reserve ${fmt(reserveShort)} short. ` : ""}The release checks the reserve again`
        : reserveShort > 0n ? `Last check found the reserve ${fmt(reserveShort)} short. Releasing checks it again.`
        : !v.checked ? "Not checked yet. Releasing checks the reserve"
        : "At the last check the reserve covered the next rounds" },
    { key: "wallet", label: "Wallet confirmation", status: phase.kind === "wallet" ? "now" : phase.kind === "sent" || done ? "done" : failedAt ? "blocked" : "todo",
      detail: phase.kind === "wallet" ? "Confirm the release in your wallet" : failedAt ? (phase as { message: string }).message : "Your wallet asks you to confirm" },
    { key: "pending", label: "Pending on chain", status: phase.kind === "sent" ? "now" : done ? "done" : "todo",
      detail: phase.kind === "sent" ? `Sent. Waiting for ${chain} to include it` : `${chain} includes the transaction` },
    { key: "released", label: "Pot released", status: done ? "done" : "todo",
      detail: done ? `${fmt(phase.amount)} left the pot in a successful transaction` : `The ${words.payer} pays the pot` },
    { key: "confirmed", label: "Confirmed", status: confirmed ? "done" : done ? "now" : "todo",
      detail: confirmed ? `${seatLabel(phase.recipientTurn)} received ${fmt(phase.amount)}` : done ? "Reading the circle again to confirm" : "The circle shows the recipient as paid" },
  ];
}

/**
 * A finished circle, on either chain: each member collects their own seat, to their own wallet, with no deadline.
 * Amounts are exact where the chain's read gives them (Robinhood: withdraw()'s own arithmetic) and null where it
 * does not (Solana: the stock is valued at withdraw time); a collected seat names no amount (its locked part reads 0
 * after withdrawing).
 */
export type CloseOut = {
  title: string;
  body: string;
  seats: { turn: number; label: string; wallet: string; you: boolean; collected: boolean; owed: boolean; amount: bigint | null }[];
  collected: number;
  owedCount: number;
  /** The connected member's seat and what withdraw pays it, when the chain's read gives the amounts. */
  mine: { turn: number; collected: boolean; owed: boolean; locked: bigint | null; pooled: bigint | null; total: bigint | null; lockedLeft?: boolean } | null;
};

/** The phase to show for this read: a failure from an earlier round does not carry into the next (no lingering). */
export function currentPhase(phase: ReleasePhase, round: number): ReleasePhase {
  return phase.kind === "failed" && phase.round !== round ? { kind: "idle" } : phase;
}
