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
 *   SPEC.md:134, "Demo circle (G5 seed script, r3)", states every one of them:
 *   n=5, c=50 USDC, g=35 USDC, haircut 2000, coverage 13000, warn 11000,
 *   min_stock_cover 120 USDC, round 120 s, grace 60 s, max_price_age 691_200,
 *   wrapper 150, share 150, multiplier 1.0, and 1.1 token locked per member
 *   giving EXEC = FUND = 165 and H = 132.
 *
 *   The guarantee is 35, NOT the 30 that the peak check's boundary allows.
 *   SPEC.md:133's peak table gives needs 140, 150, 30, 0, so the peak is 150 and
 *   n x g >= 150 makes 30 the MINIMUM legal guarantee. SPEC.md:134 then chooses
 *   35 on purpose: "reserve 175 vs peak need 150: 25 of slack so one base unit
 *   of price drift cannot pause the demo". An earlier version of this file
 *   derived 30 from the boundary and called it the demo's value, which confused
 *   the smallest guarantee that passes create_circle with the one the demo
 *   actually seeds.
 */

// Relative, not "@/": root tests load the fixtures directly (app-circle-status-adversary).
import type { CircleView, MemberView } from "../lib/circle";

const USDC = 1_000_000;
const RAW = 100_000_000;

/** The moment the fixtures are written against: one minute before the real
 *  NFLXx 10-for-1 at 1763337300 (SPEC §9b.1), so the split is a real one. */
export const FIXTURE_NOW = 1_763_337_240;

const ONE_X = 1_000_000_000;
const TEN_X = 10_000_000_000;

/** 1.1 NFLXx each. At 150/150 and multiplier 1 SPEC §4 gives FUND = EXEC = 165
 *  and H = floor(165 x 0.8) = 132 USDC, clearing the 120 USDC minimum. This is
 *  I12's own example, so the cover is computed from the formulas rather than
 *  stated. */
const LOCKED = 110_000_000;

const SEATS: ReadonlyArray<{ name: string; address: string }> = [
  { name: "Ada", address: "Fx7mAdaK3pQ1rS9tUvWxYz2bC4dE6fG8hJ1kL3mN5pQr" },
  { name: "Tunde", address: "Gy8nTun4qR2sT1uVwXyZa3cD5eF7gH9iK2lM4nP6qRst" },
  { name: "Kemi", address: "Hz9pKem5rS3tU2vWxYzAb4dE6fG8hJ1kL3mN5pQ7rStu" },
  { name: "Chidi", address: "Ja1qChi6sT4uV3wXyZaBc5eF7gH9iK2lM4nP6qR8sTuv" },
  { name: "Nneka", address: "Kb2rNne7tU5vW4xYzAbCd6fG8hJ1kL3mN5pQ7rS9tUvw" },
];

function members(
  count: number,
  roundsPaid: (turn: number) => number,
  allocated: (turn: number) => number = () => 0,
): MemberView[] {
  return SEATS.slice(0, count).map((s, turn) => ({
    turn,
    address: s.address,
    name: s.name,
    lockedRaw: LOCKED,
    roundsPaid: roundsPaid(turn),
    allocated: allocated(turn),
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
  // Round 1 (0-based). Seats 0-3 have paid this round, seat 4 has not, which is
  // paidBitmap 0b01111. Ada received in round 0, so she is the only member with
  // an obligation: O = 50 x (5 - 2) = 150, need = ceil(150 x 1.3) - 132 = 63.
  members: members(
    5,
    (turn) => (turn === 4 ? 1 : 2),
    (turn) => (turn === 0 ? 63 * USDC : 0),
  ),

  contribution: 50 * USDC,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13000,
  warnBps: 11000,
  guaranteePerMember: 35 * USDC,
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

  // 5 members x 35 USDC guarantee. SPEC.md:134: 175 against a peak need of 150,
  // so 25 of slack.
  reserveTotal: 175 * USDC,
  reserveLosses: 0,
  // Ada's need_i, the only non-zero one at this round.
  reserveAllocated: 63 * USDC,

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
    reserveTotal: 70 * USDC,
    heldContributions: 0,
    reserveAllocated: 0,
    members: members(5, () => 0).map((m) =>
      m.turn < 2 ? m : { ...m, lockedRaw: 0 },
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
    round: 2,
    roundDeadline: FIXTURE_NOW + 74,
    paidBitmap: ALL,
    // Ada received in round 0 then defaulted; Tunde received in round 1.
    receivedBitmap: 0b00011,
    defaultedBitmap: 0b00001,
    // SPEC §7's halt example needs the gate's `remaining`, which SPEC.md:126
    // defines as R - L, to be exactly 70. The waterfall took Ada's own 35 USDC
    // guarantee first, then 70 from the pooled reserve: 175 - 105 = 70.
    reserveLosses: 105 * USDC,
    // Ada is defaulted, so her allocation is released and her obligations are
    // prepaid. Tunde owes 50 x (5 - 3) = 100, and ceil(100 x 1.3) = 130 is under
    // his 132 of stock cover, so he needs no reserve. Nothing is allocated.
    reserveAllocated: 0,
    nextGateShortBy: 5 * USDC,
    members: members(5, (turn) => (turn === 0 ? 5 : 3)),
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
    // Every seat has paid all five rounds, so O_i is zero for everyone and no
    // reserve is allocated against anything.
    reserveAllocated: 0,
    members: members(5, () => 5),
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
    reserveTotal: 70 * USDC,
    reserveAllocated: 0,
    heldContributions: 0,
    members: members(5, () => 0),
  },
} satisfies Record<string, CircleView>;

export type CircleStateKey = keyof typeof CIRCLE_STATES;

export const STATE_KEYS = Object.keys(CIRCLE_STATES) as CircleStateKey[];

/** "Open demo circle" lands here. */
export const DEMO_STATE: CircleStateKey = "active";

/** A stale price is a property of the clock, not of the fixture, so it is
 *  produced by reading the demo circle far enough after its last refresh. */
export const STALE_NOW = FIXTURE_NOW + 691_200 + 3_600;

/**
 * What a joiner is told to lock. SPEC.md:134: "Each member locks 1.1 token".
 *
 * Not the same as the minimum. At 150 a token with a 20% margin, exactly 1.0
 * token counts for 120 USDC, which IS min_stock_cover, so a joiner locking the
 * minimum starts with zero headroom and the first tick of price drift puts them
 * under it. The demo seeds 1.1 for the same reason the guarantee is 35 rather
 * than 30: slack.
 */
export const DEMO_LOCK_RAW = LOCKED;

export { USDC, RAW };
