/**
 * Whether a wallet can join a forming Solana circle's seat, by everything the page can know before the program checks
 * (PR 2, Joshua 2026-10-08): the least stock (minJoinStock, join_and_lock's CollateralBelowMinimum rule), the wallet's
 * stock account and balance, its test USDC for the guarantee, and anything that blocks every send (no wallet, a
 * transaction in flight, the price). Pure. No "@/" imports: tests import it directly.
 */
import { unitsText } from "./actions";
import { formatDuration, isStale, minJoinStock, type CircleView } from "./circle";
import { multiplierAt, toFixed1e9, type ScaledUi } from "./scaledUi";

/**
 * The circle as join_and_lock would value it at `now` (wall clock, seconds): the multiplier in force then, which a
 * split can change after the page's last read (adversary on 16ea294). Pure.
 */
export function joinViewAt(c: CircleView, split: Pick<ScaledUi, "multiplier" | "newMultiplier" | "effectiveAt">, now: number): CircleView {
  return { ...c, effectiveMultiplier: toFixed1e9(multiplierAt(split as ScaledUi, now)) };
}

/**
 * Why join_and_lock would refuse ANY amount at `now` because of the price (valuation.rs value_position: PriceStale,
 * MultiplierPriceMismatch), or null. Judged at `now`, not at the read: a price ages and a split takes effect between
 * reads, and reads can keep failing (adversary on b620e79). Pure.
 */
export function joinPriceProblem(c: CircleView, split: Pick<ScaledUi, "multiplier" | "newMultiplier" | "effectiveAt">, now: number): string | null {
  if (c.feed.wrapperPrice === 0 || c.feed.sharePrice === 0) return "No price has been set for the stock yet, and joining needs a set, fresh price.";
  if (isStale(c, now)) return `The price is ${formatDuration(now - c.feed.updatedAt)} old, and joining needs a fresh one.`;
  // repricing by the read or by the clock: either way join_and_lock may refuse (blocking for at most one read when a
  // price set ahead for a scheduled split comes into force)
  if (c.effectiveMultiplier !== c.feed.pricedForMultiplier || joinViewAt(c, split, now).effectiveMultiplier !== c.feed.pricedForMultiplier) {
    return "Price and split disagree (repricing): joining waits for a price set for the new multiplier.";
  }
  return null;
}

export const STOCK_DECIMALS = 8;

/** A wallet's balances as this page last read them: null for a token account that does not exist. */
export type JoinBalances = { stock: bigint | null; usdc: bigint | null };
/** Where the page's read of a wallet's balances stands. */
export type BalanceRead = JoinBalances | "reading" | "failed";

/**
 * Whether this wallet can join with `raw` of stock, by everything the page can know, and if not, why. `blocked` is the
 * parent's reason none of the circle's sends can go now (no wallet, a transaction in flight, the price). Pure.
 */
export function joinReadiness(
  c: CircleView,
  raw: bigint | null,
  balances: BalanceRead,
  blocked: string | null,
  words: { stock: string; usdc: (base: bigint) => string },
): { enabled: boolean; reason: string | null } {
  if (blocked) return { enabled: false, reason: blocked };
  const least = minJoinStock(c);
  if (least === null) return { enabled: false, reason: "No amount of stock reaches this circle's minimum cover at the current price." };
  if (raw === null) return { enabled: false, reason: `Type how much ${words.stock} to lock.` };
  if (raw < least) return { enabled: false, reason: `This circle needs at least ${unitsText(least, STOCK_DECIMALS)} ${words.stock}.` };
  if (balances === "reading") return { enabled: false, reason: "Reading this wallet's balances…" };
  if (balances === "failed") return { enabled: false, reason: "This wallet's balances could not be read; they are read again with the next circle read." };
  const guarantee = BigInt(c.guaranteePerMember);
  if (balances.stock === null) return { enabled: false, reason: `This wallet has no ${words.stock} account. Get the stock into it first.` };
  if (balances.stock < raw) return { enabled: false, reason: `This wallet holds ${unitsText(balances.stock, STOCK_DECIMALS)} ${words.stock}; joining with this amount needs ${unitsText(raw, STOCK_DECIMALS)}.` };
  if ((balances.usdc ?? 0n) < guarantee) return { enabled: false, reason: `This wallet holds ${words.usdc(balances.usdc ?? 0n)}; the guarantee is ${words.usdc(guarantee)}.` };
  return { enabled: true, reason: null };
}

