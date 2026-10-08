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
export function joinViewAt(c: CircleView, split: Pick<ScaledUi, "multiplier" | "newMultiplier" | "effectiveAt">, now: number): CircleView | null {
  // toFixed1e9 refuses a multiplier it cannot carry exactly; the page then names no figure and never throws while it
  // renders (adversary on e0d1637: an absurd scheduled multiplier crashed the whole page)
  try {
    return { ...c, effectiveMultiplier: toFixed1e9(multiplierAt(split as ScaledUi, now)) };
  } catch {
    return null;
  }
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
  const at = joinViewAt(c, split, now);
  if (!at) return "The stock's multiplier in force cannot be shown exactly by this app, so it names no figure; join from the Othello devnet tools.";
  if (c.effectiveMultiplier !== c.feed.pricedForMultiplier || at.effectiveMultiplier !== c.feed.pricedForMultiplier) {
    return "Price and split disagree (repricing): joining waits for a price set for the new multiplier.";
  }
  return null;
}

export const STOCK_DECIMALS = 8;

/** A wallet's balances as this page last read them: null for a token account that does not exist. */
/**
 * The accounts join_and_lock creates with the joining wallet as payer (join_and_lock.rs: the Member always; the
 * member's USDC account and the circle's two vaults when they do not exist yet), by their exact data sizes:
 * Member = 8 + Member::INIT_SPACE (state.rs: 32+32+1+1+8+8+8+8+1+8+4 = 111), an SPL token account 165, a Token-2022
 * account for the stock (ImmutableOwner) 170. tests/b2-solana-forming-actions.spec.ts checks the lamports a join
 * really spends against joinLamports.
 */
export const JOIN_SPACE = { member: 119, usdcAccount: 165, stockVault: 170, usdcVault: 165 } as const;
/** One signature's base fee, in lamports (no priority fee is set). */
export const BASE_FEE = 5_000n;

/** The SOL a join costs this wallet, in lamports: the rent of every account it creates, and the fee. */
export function joinLamports(missing: { usdcAccount: boolean; stockVault: boolean; usdcVault: boolean }, rent: (space: number) => bigint): bigint {
  return BASE_FEE + rent(JOIN_SPACE.member)
    + (missing.usdcAccount ? rent(JOIN_SPACE.usdcAccount) : 0n)
    + (missing.stockVault ? rent(JOIN_SPACE.stockVault) : 0n)
    + (missing.usdcVault ? rent(JOIN_SPACE.usdcVault) : 0n);
}

/** `sol` / `solNeeded` in lamports: what the wallet holds, and what joinLamports says the join costs it. */
export type JoinBalances = { stock: bigint | null; usdc: bigint | null; sol: bigint; solNeeded: bigint };
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
  if (balances.sol < balances.solNeeded) {
    return { enabled: false, reason: `This wallet holds ${unitsText(balances.sol, 9)} devnet SOL; joining needs ${unitsText(balances.solNeeded, 9)} for the seat account's rent and the fee (free from faucet.solana.com).` };
  }
  return { enabled: true, reason: null };
}

