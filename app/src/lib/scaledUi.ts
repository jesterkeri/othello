/**
 * Token-2022's ScaledUiAmountConfig (extension 25), read from a mint's raw
 * bytes. The live circle reads it from the NFLXx devnet mirror and the real
 * xStocks panel reads it from the four mainnet mints, through this one function,
 * so both show the multiplier the same way.
 *
 * Layout (Token-2022): the 82-byte mint, zero padding to 165, one account-type
 * byte at 165, then TLV entries from 166, each a u16 type, a u16 length and the
 * value. Real xStocks carry several extensions, so this walks the list rather
 * than assuming the one at 166. The value of type 25 is: authority 32 bytes,
 * multiplier f64, new_multiplier_effective_timestamp i64, new_multiplier f64.
 *
 * Display only. The program decodes the same bytes for itself (T02/T03) and is
 * the authority on value; this file only labels what it decided.
 *
 * No "@/" imports: tests/app-scaled-ui.spec.ts runs it from the repo root.
 */

export const SCALED_UI_AMOUNT = 25;
const TLV_START = 166;

export type ScaledUi = {
  multiplier: number;
  newMultiplier: number;
  /** Unix seconds at which newMultiplier takes over. */
  effectiveAt: number;
};

export type MintSummary = {
  decimals: number;
  /** Raw supply, u64, as a string so no precision is lost. */
  supply: string;
  scaledUi: ScaledUi | null;
};

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** The extension's value, or null if the mint has none (or is not Token-2022). */
export function readScaledUi(data: Uint8Array): ScaledUi | null {
  if (data.length <= TLV_START) return null;
  // Account type at 165: 1 = Mint. Anything else is not a Token-2022 mint.
  if (data[165] !== 1) return null;
  const v = view(data);
  let off = TLV_START;
  while (off + 4 <= data.length) {
    const type = v.getUint16(off, true);
    const len = v.getUint16(off + 2, true);
    if (type === 0) return null; // Uninitialized: the end of the list.
    if (off + 4 + len > data.length) return null;
    if (type === SCALED_UI_AMOUNT) {
      if (len < 56) return null;
      const at = off + 4;
      return {
        multiplier: v.getFloat64(at + 32, true),
        effectiveAt: Number(v.getBigInt64(at + 40, true)),
        newMultiplier: v.getFloat64(at + 48, true),
      };
    }
    off += 4 + len;
  }
  return null;
}

export function readMint(data: Uint8Array): MintSummary {
  const v = view(data);
  return { decimals: data[44] ?? 0, supply: v.getBigUint64(36, true).toString(), scaledUi: readScaledUi(data) };
}

/** The multiplier in force at `now` (unix seconds). */
export function multiplierAt(s: ScaledUi, now: number): number {
  return now >= s.effectiveAt ? s.newMultiplier : s.multiplier;
}

/**
 * floor(m x 1e9), EXACTLY, from the f64's bits: a port of the program's
 * decode_multiplier_fixed (programs/othello/src/valuation.rs, SPEC I5).
 *
 * T18 adversary: this used to be Math.round(m * 1e9), which puts AAPLx's real
 * 1.0026642075893797 at 1002664208 where the program has 1002664207, so the
 * screen said Repricing while the program quoted the prices as current. The
 * app must land on the program's integer, not a nearby one.
 *
 * Throws, as the program refuses, for anything that cannot be a live
 * multiplier: negative (including -0), NaN, infinity, past u64, or flooring to 0.
 */
export function toFixed1e9(m: number): number {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, m, true);
  const bits = v.getBigUint64(0, true);
  const invalid = () => new Error(`Multiplier ${m} cannot be a live multiplier (the program refuses it)`);

  if (bits & 0x8000_0000_0000_0000n) throw invalid();
  const exponentField = Number((bits >> 52n) & 0x7ffn);
  const mantissa = bits & 0x000f_ffff_ffff_ffffn;
  if (exponentField === 0x7ff) throw invalid();

  const [significand, exponent] =
    exponentField === 0 ? [mantissa, 1 - 1023 - 52] : [mantissa | (1n << 52n), exponentField - 1023 - 52];
  const scaled = significand * 1_000_000_000n;
  const fixed = exponent >= 0 ? scaled << BigInt(exponent) : scaled >> BigInt(-exponent);

  if (fixed === 0n || fixed > 0xffff_ffff_ffff_ffffn) throw invalid();
  if (fixed > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(fixed);
}
