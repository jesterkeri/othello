import type { RhCircleView } from "./adapter";

type ReserveDisplay = {
  heading: string;
  amount: bigint;
  lines: readonly (readonly ["+" | "−" | "=" | "→", string, bigint])[];
};

/**
 * Keep the reserve card's words aligned with the contract's accounting.
 * During a live circle, `reserveAllocated` is already committed to members'
 * unpaid obligations, so it is not free reserve. After the circle ends those
 * allocations no longer restrict withdrawals; the remaining withdrawal pool
 * is guarantees after losses plus escrow, less prior withdrawals.
 */
export function reserveDisplay(v: Pick<RhCircleView, "status" | "reserveTotal" | "reserveLosses" | "reserveAllocated" | "escrow" | "withdrawnFromReserve" | "nextGateShortBy">): ReserveDisplay {
  const afterLosses = v.reserveTotal - v.reserveLosses;
  const finished = v.status === "Completed" || v.status === "Cancelled";

  if (finished) {
    const waitingToWithdraw = afterLosses + v.escrow - v.withdrawnFromReserve;
    return {
      heading: "Shared reserve to withdraw",
      amount: waitingToWithdraw,
      lines: [
        ["+", "Guarantees left after defaults", afterLosses],
        ["+", "Default-payment escrow", v.escrow],
        ["−", "Already withdrawn", v.withdrawnFromReserve],
        ["=", "Still available to withdraw", waitingToWithdraw],
      ],
    };
  }

  const free = afterLosses - v.reserveAllocated;
  return {
    heading: "Shared reserve, free",
    amount: free,
    lines: [
      ["+", "Guarantees deposited", v.reserveTotal],
      ["−", "Spent on defaults", v.reserveLosses],
      ["−", "Set aside for unpaid obligations", v.reserveAllocated],
      ["=", "Free reserve", free],
      ["→", "Needed to clear the payout gate", v.nextGateShortBy],
    ],
  };
}
