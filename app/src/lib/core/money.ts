/**
 * Amounts in each chain's own unit (Joshua 2026-10-06: Robinhood shows USDG, Solana USDC), from base units. Exact:
 * bigint arithmetic, trailing zeros trimmed, thousands separated.
 */
export type Money = { unit: "USDG" | "USDC"; decimals: number };

export const USDG: Money = { unit: "USDG", decimals: 6 };
export const USDC: Money = { unit: "USDC", decimals: 6 };

export function fmtMoney(m: Money, v: bigint): string {
  const scale = 10n ** BigInt(m.decimals);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / scale;
  const frac = (a % scale).toString().padStart(m.decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} ${m.unit}`;
}

/** USDG base units (6 dp). */
export const fmtUsdg = (v: bigint): string => fmtMoney(USDG, v);
