/**
 * Pure formatting shared by the pages and the root tests. No "@/" imports and no browser APIs: the
 * root typecheck and mocha load this file directly (a hook module here broke the root tsc).
 */
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
