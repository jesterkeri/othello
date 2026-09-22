/**
 * The Circle as the app reads it.
 *
 * Field names and units mirror the on-chain account in
 * programs/othello/src/state.rs, so a fixture and a decoded account are the
 * same shape. SPEC.md:33 fixes the units: `usdc` is 6-dp base units, `raw` is
 * 8-dp stock base units, prices are USDC base units per whole token, and the
 * multiplier is fixed-point x1e9.
 *
 * Nothing here computes collateral. Coverage is the program's answer
 * (quote_valuation), and the app displays what it is given rather than
 * re-deriving money, which design/reviews/design-review-r2.md:69 warned would
 * duplicate the valuation in the frontend.
 */

/** programs/othello/src/state.rs: MAX_MEMBERS. */
export const MAX_MEMBERS = 8;

/** SPEC.md:33. */
export const USDC_DECIMALS = 6;
export const RAW_DECIMALS = 8;

/** The on-chain enum, state.rs CircleStatus. */
export type CircleStatus = "Forming" | "Active" | "Completed" | "Cancelled";

export type PriceFeedView = {
  wrapperPrice: number;
  sharePrice: number;
  /** Fixed-point x1e9, the multiplier these prices were stamped for. */
  pricedForMultiplier: number;
  updatedAt: number;
};

export type MemberView = {
  /** Turn order, 0-based. This is the seat, not an index into a filtered list. */
  turn: number;
  address: string;
  /** Display name. The chain stores only the address. */
  name: string;
  /** Counted value of their locked stock, in usdc. From quote_valuation. */
  stockCover: number;
  /** Raw stock base units locked. */
  lockedRaw: number;
};

export type CircleView = {
  circleId: number;
  creator: string;
  stockSymbol: string;

  n: number;
  members: MemberView[];

  contribution: number;
  roundSecs: number;
  graceSecs: number;
  haircutBps: number;
  coverageBps: number;
  guaranteePerMember: number;
  minStockCover: number;
  maxPriceAge: number;

  status: CircleStatus;
  /** 0-based, as on chain. */
  round: number;
  roundDeadline: number;

  paidBitmap: number;
  joinedBitmap: number;
  withdrawnBitmap: number;
  receivedBitmap: number;
  defaultedBitmap: number;

  reserveTotal: number;
  reserveLosses: number;
  reserveAllocated: number;

  escrow: number;
  escrowDeficit: number;
  nextGateShortBy: number;
  heldContributions: number;
  lastCoverageAt: number;

  feed: PriceFeedView;
  /** The mint's effective multiplier now, fixed-point x1e9. */
  effectiveMultiplier: number;
};

/** Seat `turn` is set in `bitmap`. Seats are 0-based, so seat 0 is bit 0. */
export function seatSet(bitmap: number, turn: number): boolean {
  return (bitmap & (1 << turn)) !== 0;
}

export function countSeats(bitmap: number, n: number): number {
  let count = 0;
  for (let turn = 0; turn < n; turn += 1) if (seatSet(bitmap, turn)) count += 1;
  return count;
}

/**
 * Paused is not a status on chain. SPEC §5 and design/FLOWS.md:311 define it as
 * next_gate_short_by > 0, which is why it can be true of an Active circle.
 */
export function isPaused(c: CircleView): boolean {
  return c.status === "Active" && c.nextGateShortBy > 0;
}

/** D6. Prices older than the circle's own max_price_age. */
export function isStale(c: CircleView, now: number): boolean {
  return now - c.feed.updatedAt > c.maxPriceAge;
}

/**
 * D5. Fundamental value is only computed when the mint's effective multiplier
 * equals the one the prices were stamped for. Otherwise the circle is
 * Repricing and releasing, updating coverage and joining all refuse.
 */
export function isRepricing(c: CircleView): boolean {
  return c.feed.pricedForMultiplier !== c.effectiveMultiplier;
}

/** The seat whose turn it is. Turn order is the member array's own order. */
export function recipient(c: CircleView): MemberView | undefined {
  return c.members.find((m) => m.turn === c.round);
}

export function missingContributions(c: CircleView): number {
  // The recipient pays in too; every seat owes every round.
  return c.n - countSeats(c.paidBitmap, c.n);
}

export function roundFunded(c: CircleView): boolean {
  return missingContributions(c) === 0;
}

/** Seconds until the round deadline. Negative once it has passed. */
export function secondsToDeadline(c: CircleView, now: number): number {
  return c.roundDeadline - now;
}

/** Grace runs from the deadline, so a default can only be declared after both. */
export function secondsToGraceEnd(c: CircleView, now: number): number {
  return c.roundDeadline + c.graceSecs - now;
}

/** Reserve still available to cover a gate, after losses and allocations. */
export function reserveAvailable(c: CircleView): number {
  return Math.max(0, c.reserveTotal - c.reserveLosses - c.reserveAllocated);
}

export function formatUsdc(base: number, dp = 2): string {
  return (base / 10 ** USDC_DECIMALS).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

export function formatRaw(base: number, dp = 4): string {
  return (base / 10 ** RAW_DECIMALS).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/**
 * "{age} ago" for the coverage helper, and the countdown. Whole units only:
 * the demo's rounds are 120 seconds (D10), so a spinning seconds counter would
 * be the loudest thing on the screen.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}..${address.slice(-4)}` : address;
}

/** Everything the Circle screen needs to decide what to show, in one place. */
export type CircleDerived = {
  paused: boolean;
  stale: boolean;
  repricing: boolean;
  recipient: MemberView | undefined;
  missing: number;
  funded: boolean;
  available: number;
  joined: number;
  toDeadline: number;
  toGraceEnd: number;
  coverageAge: number;
  priceAge: number;
};

export function derive(c: CircleView, now: number): CircleDerived {
  return {
    paused: isPaused(c),
    stale: isStale(c, now),
    repricing: isRepricing(c),
    recipient: recipient(c),
    missing: missingContributions(c),
    funded: roundFunded(c),
    available: reserveAvailable(c),
    joined: countSeats(c.joinedBitmap, c.n),
    toDeadline: secondsToDeadline(c, now),
    toGraceEnd: secondsToGraceEnd(c, now),
    coverageAge: now - c.lastCoverageAt,
    priceAge: now - c.feed.updatedAt,
  };
}
