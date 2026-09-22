/**
 * Circle fixtures for S4.
 *
 * These are FIXTURES, not chain reads. Nothing here is fetched and nothing is
 * claimed to be live: the screen renders from these until the devnet circle
 * exists (S2, T23). The addresses are fixture addresses, not wallets anyone
 * holds.
 *
 * Every parameter is the demo circle's own, derived from the SPEC rather than
 * chosen:
 *
 *   SPEC §10 G2 reproduces the peak table as "needs 140, 150, 30, 0" and
 *   requires g = 29 to be refused. Four terms means n = 5, and the peak is 150,
 *   so n x g >= peak puts the guarantee at exactly 30 USDC (5 x 29 = 145 < 150).
 *   Solving the four terms with coverage_bps = 13000 (SPEC.md:44) gives
 *   contribution x coverage = 65 USDC, so contribution = 50 USDC, and
 *   min_stock_cover = 120 USDC.
 *
 *   I12's worked example (1.1 token, 150/150, multiplier 10, share 15, H = 132)
 *   fixes the haircut: min(165, 165) x (1 - h) = 132, so haircut_bps = 2000.
 *
 *   D10 fixes 120 s rounds and 60 s grace. SPEC.md:48 fixes max_price_age at
 *   691_200, eight days, so judging never sees a stale banner.
 */

import type { CircleView, MemberView } from "@/lib/circle";

const USDC = 1_000_000;
const RAW = 100_000_000;

/** The moment the fixtures are written against: one minute before the real
 *  NFLXx 10-for-1 at 1763337300 (SPEC §9b.1), so the split is a real one. */
export const FIXTURE_NOW = 1_763_337_240;

const ONE_X = 1_000_000_000;
const TEN_X = 10_000_000_000;

/** 1.1 NFLXx each. At 150/150 and multiplier 1 that counts for 132 USDC,
 *  clearing the 120 USDC minimum. This is I12's own example. */
const LOCKED = 110_000_000;
const COVER = 132 * USDC;

const SEATS: ReadonlyArray<{ name: string; address: string }> = [
  { name: "Ada", address: "Fx7mAdaK3pQ1rS9tUvWxYz2bC4dE6fG8hJ1kL3mN5pQr" },
  { name: "Tunde", address: "Gy8nTun4qR2sT1uVwXyZa3cD5eF7gH9iK2lM4nP6qRst" },
  { name: "Kemi", address: "Hz9pKem5rS3tU2vWxYzAb4dE6fG8hJ1kL3mN5pQ7rStu" },
  { name: "Chidi", address: "Ja1qChi6sT4uV3wXyZaBc5eF7gH9iK2lM4nP6qR8sTuv" },
  { name: "Nneka", address: "Kb2rNne7tU5vW4xYzAbCd6fG8hJ1kL3mN5pQ7rS9tUvw" },
];

function members(count: number): MemberView[] {
  return SEATS.slice(0, count).map((s, turn) => ({
    turn,
    address: s.address,
    name: s.name,
    stockCover: COVER,
    lockedRaw: LOCKED,
  }));
}

/** All five seats set: 0b11111. */
const ALL = 0b11111;

/** The demo circle's parameters. Shared by every state below. */
const base: CircleView = {
  circleId: 1,
  creator: SEATS[0]!.address,
  stockSymbol: "NFLXx",

  n: 5,
  members: members(5),

  contribution: 50 * USDC,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13000,
  guaranteePerMember: 30 * USDC,
  minStockCover: 120 * USDC,
  maxPriceAge: 691_200,

  status: "Active",
  round: 1,
  roundDeadline: FIXTURE_NOW + 74,

  paidBitmap: 0b01111,
  joinedBitmap: ALL,
  withdrawnBitmap: 0,
  receivedBitmap: 0b00001,
  defaultedBitmap: 0,

  // 5 members x 30 USDC guarantee.
  reserveTotal: 150 * USDC,
  reserveLosses: 0,
  reserveAllocated: 0,

  escrow: 0,
  escrowDeficit: 0,
  nextGateShortBy: 0,
  heldContributions: 200 * USDC,
  lastCoverageAt: FIXTURE_NOW - 46,

  feed: {
    wrapperPrice: 150 * USDC,
    sharePrice: 150 * USDC,
    pricedForMultiplier: ONE_X,
    updatedAt: FIXTURE_NOW - 46,
  },
  effectiveMultiplier: ONE_X,
};

/**
 * The six Data states of the Circle place (design/FLOWS.md §7, four axes).
 * Paused and Repricing are not on-chain statuses: Paused is
 * next_gate_short_by > 0 and Repricing is a multiplier disagreement, so both
 * are Active circles carrying a different fact.
 */
export const CIRCLE_STATES = {
  /** Two of five have joined, so the round has not started. */
  forming: {
    ...base,
    status: "Forming",
    round: 0,
    roundDeadline: 0,
    joinedBitmap: 0b00011,
    paidBitmap: 0,
    receivedBitmap: 0,
    reserveTotal: 60 * USDC,
    heldContributions: 0,
    members: members(5).map((m) =>
      m.turn < 2 ? m : { ...m, stockCover: 0, lockedRaw: 0 },
    ),
  },

  /** Round 2 of 5, Tunde's turn, one contribution outstanding. */
  active: base,

  /**
   * SPEC §7's halt example: the gate needs 75 and 70 remains, so short_by is 5
   * and the circle is Paused until someone tops up exactly that.
   */
  paused: {
    ...base,
    reserveLosses: 80 * USDC,
    nextGateShortBy: 5 * USDC,
    paidBitmap: ALL,
  },

  /**
   * The mint's effective multiplier has moved to 10 and the feed is still
   * stamped for 1, so fundamental value cannot be computed (D5). Releasing,
   * updating coverage and joining all refuse until the admin sets a matching
   * price.
   */
  repricing: {
    ...base,
    effectiveMultiplier: TEN_X,
    paidBitmap: ALL,
  },

  /** Every seat has received once; nothing is held and withdrawals are open. */
  completed: {
    ...base,
    status: "Completed",
    round: 4,
    roundDeadline: FIXTURE_NOW - 600,
    paidBitmap: ALL,
    receivedBitmap: ALL,
    withdrawnBitmap: 0b00011,
    heldContributions: 0,
  },

  /** Cancelled while Forming, so every deposit goes back untouched. */
  cancelled: {
    ...base,
    status: "Cancelled",
    round: 0,
    roundDeadline: 0,
    joinedBitmap: 0b00011,
    paidBitmap: 0,
    receivedBitmap: 0,
    reserveTotal: 60 * USDC,
    heldContributions: 0,
  },
} satisfies Record<string, CircleView>;

export type CircleStateKey = keyof typeof CIRCLE_STATES;

export const STATE_KEYS = Object.keys(CIRCLE_STATES) as CircleStateKey[];

/** "Open demo circle" lands here. */
export const DEMO_STATE: CircleStateKey = "active";

/** A stale price is a property of the clock, not of the fixture, so it is
 *  produced by reading the demo circle far enough after its last refresh. */
export const STALE_NOW = FIXTURE_NOW + 691_200 + 3_600;

export { USDC, RAW };
