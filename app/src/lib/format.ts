/**
 * Pure formatting shared by the pages and the root tests. No "@/" imports and no browser APIs: the
 * root typecheck and mocha load this file directly (a hook module here broke the root tsc).
 */
import { toFixed1e9 } from "./scaledUi";

/**
 * A raw u64 supply in whole tokens, EXACTLY: every digit of the on-chain integer, split at the
 * mint's decimals with string arithmetic, so nothing is rounded (Codex T18 r2: "Supply, raw" was
 * a rounded decimal). 15505685531324 at 8 decimals -> "155,056.85531324".
 */
export function exactTokens(raw: string, decimals: number): string {
  const digits = BigInt(raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? digits.slice(digits.length - decimals) : "";
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * What a wallet shows for a raw u64 balance: raw x multiplier, in whole tokens, computed on the
 * integer with the multiplier at 9 decimals (the program's fixed point, SPEC §4) and floored, so no
 * digit comes from a float (Codex T18d r2: Portfolio rounded u64 balances through Number).
 */
export function shownTokens(raw: string, decimals: number, multiplier: number): string {
  // SPEC I5: mult_fixed = floor(true value x 1e9), from the f64's bits (toFixed1e9 is the program's
  // decode_multiplier_fixed, ported bit for bit). Math.round overstated holdings (adversary pass 4).
  const fixed = BigInt(toFixed1e9(multiplier));
  return exactTokens(((BigInt(raw) * fixed) / 1_000_000_000n).toString(), decimals);
}
