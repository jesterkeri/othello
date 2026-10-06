/**
 * One circle as the shared circles list sees it, on either chain (Joshua 2026-10-06: one frontend for Robinhood and
 * Solana, fed by each chain's adapter, with the same capabilities on both). Each chain maps its own read into this
 * (lib/robinhood/to-list.ts, lib/to-list-solana.ts) and computes the facts only it knows: whether this round's pot can
 * be released by its contract's rules, and what this wallet collects from a finished circle.
 */
import type { ChainSide } from "../chains";
import type { Money } from "./money";
import { sameAddress, type RingSource } from "./ring";

export type ListSeat = RingSource["seats"][number];

export type ListCircle = RingSource & {
  side: ChainSide;
  /** The circle's account or contract address. */
  address: string;
  /** Its page. */
  href: string;
  creator: string;
  /** The shared reserve, in the money unit. */
  reserveTotal: bigint;
  /** The unit contributions and pots are paid in. */
  money: Money;
  /** What a member locks: "USDG" on Robinhood, the circle's stock on Solana. */
  collateral: string;
  /** This round's pot can be released now, by the chain's own rules (anyone may release it on both chains). */
  releasable: boolean;
  /**
   * The chain's own stored "Paused" figure (nextGateShortBy on both chains): how much reserve the next payout was
   * short at the last coverage check, 0 when it was not. The UI never computes the gate (SPEC.md, payout gate); the
   * circle page still lets anyone try the release, and the chain re-checks.
   */
  pausedShortBy: bigint;
  /** Finished circles only: who has collected, and this wallet's own share (amount null when the chain gives none). */
  closeOut: { collected: number; owedCount: number; mine: { owed: boolean; collected: boolean; amount: bigint | null } | null } | null;
};

const same = sameAddress;

export const mySeat = (c: ListCircle, me: string | null | undefined): ListSeat | null => c.seats.find((s) => same(s.wallet, me)) ?? null;
export const isCreator = (c: ListCircle, me: string | null | undefined) => same(c.creator, me);

/** The circles page's words for each chain: its title and where "Start a circle" goes. */
export const CHAIN_PAGE: Record<ChainSide, { title: string; startHref: string }> = {
  robinhood: { title: "Your Robinhood circles", startHref: "/robinhood/new" },
  solana: { title: "Your Solana circles", startHref: "/circle/new" },
};
