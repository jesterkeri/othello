//! Exact fixed-point decode of the Token-2022 scaled-UI multiplier (ADR-001).
//!
//! The mint carries the multiplier as an IEEE-754 binary64. Multiplying that
//! float by 1e9 and casting is wrong in real cases: the f64 nearest 1.0000003
//! is slightly below it, but `1.0000003_f64 * 1e9` rounds to exactly
//! 1000000300.0, so the cast yields 1000000300 where the true floor is
//! 1000000299. One extra billionth of multiplier is one extra billionth of
//! every member's collateral, in the overvaluing direction.
//!
//! So the value is never materialised as a float. The sign, exponent and
//! mantissa are read as integers and combined exactly in u128:
//! a binary64 is `significand × 2^exponent` with both integral, so
//! `floor(value × 1e9)` is an exact shift of `significand × 1e9`.
//!
//! This module takes raw bits rather than a `PodF64` so it stays independent of
//! the Token-2022 layout; T03 reads the bits out of `ScaledUiAmountConfig` and
//! passes them in.

use anchor_lang::prelude::*;

use crate::errors::OthelloError;

/// Multipliers are carried through the program as integers scaled by 1e9 (SPEC §4).
pub const MULTIPLIER_SCALE: u64 = 1_000_000_000;

// IEEE-754 binary64 field layout.
const SIGN_MASK: u64 = 0x8000_0000_0000_0000;
const EXPONENT_MASK: u64 = 0x7FF0_0000_0000_0000;
const MANTISSA_MASK: u64 = 0x000F_FFFF_FFFF_FFFF;
const MANTISSA_BITS: u32 = 52;
const IMPLICIT_LEADING_ONE: u64 = 1 << MANTISSA_BITS;
const EXPONENT_BIAS: i32 = 1023;
const EXPONENT_ALL_ONES: i32 = 0x7FF;
/// `significand × 2^this` for a subnormal: 2^(1 − bias) with the point moved
/// across all 52 mantissa bits.
const SUBNORMAL_EXPONENT: i32 = 1 - EXPONENT_BIAS - MANTISSA_BITS as i32;

/// `floor(multiplier × 1e9)`, exactly, from the raw binary64 bits (I5).
///
/// Refuses anything that cannot be a live multiplier: NaN, either infinity,
/// anything negative (which includes `-0.0`), anything that scales past u64,
/// and anything that floors to zero. Zero is refused rather than returned
/// because a zero multiplier does not mean "worth nothing", it means the mint
/// is not telling us what the asset is worth; SPEC §9 calls that asset
/// ineligible. Subnormals reach the same refusal by the same route, since every
/// subnormal floors to zero at this scale.
pub fn decode_multiplier_fixed(bits: u64) -> Result<u64> {
    if bits & SIGN_MASK != 0 {
        return err!(OthelloError::MultiplierInvalid);
    }

    let exponent_field = ((bits & EXPONENT_MASK) >> MANTISSA_BITS) as i32;
    let mantissa = bits & MANTISSA_MASK;

    if exponent_field == EXPONENT_ALL_ONES {
        // Infinity (mantissa zero) or NaN (mantissa non-zero).
        //
        // Redundant today, and deliberately kept. Every non-finite pattern has
        // exponent_field 0x7FF, so treating one as a normal number gives a
        // 2^972 shift that the overflow guard below refuses anyway, with the
        // same error. A mutation run confirms it: deleting these lines leaves
        // the whole suite green. What it buys is that the refusal says what it
        // means, and that it survives any later change to the output width,
        // which is the thing that currently makes the overflow guard fire.
        return err!(OthelloError::MultiplierInvalid);
    }

    let (significand, exponent) = if exponent_field == 0 {
        (mantissa, SUBNORMAL_EXPONENT)
    } else {
        (
            mantissa | IMPLICIT_LEADING_ONE,
            exponent_field - EXPONENT_BIAS - MANTISSA_BITS as i32,
        )
    };

    // significand < 2^53 and MULTIPLIER_SCALE < 2^30, so this is under 2^83.
    let scaled = (significand as u128)
        .checked_mul(MULTIPLIER_SCALE as u128)
        .ok_or(OthelloError::MultiplierInvalid)?;

    let fixed = if exponent >= 0 {
        let shift = exponent as u32;
        if shift >= u128::BITS {
            return err!(OthelloError::MultiplierInvalid);
        }
        // Note: not checked_shl, which only rejects an oversized shift and
        // silently drops the bits that leave the top.
        scaled
            .checked_mul(1u128 << shift)
            .ok_or(OthelloError::MultiplierInvalid)?
    } else {
        let shift = exponent.unsigned_abs();
        if shift >= u128::BITS {
            // Everything this small floors to zero, and zero is refused below.
            0
        } else {
            // Truncating shift of a positive integer: this is the floor.
            scaled >> shift
        }
    };

    let fixed = u64::try_from(fixed).map_err(|_| error!(OthelloError::MultiplierInvalid))?;

    if fixed == 0 {
        return err!(OthelloError::MultiplierInvalid);
    }

    Ok(fixed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real mint values from SPEC §9b.1, plus ADR-001's rounding case.
    /// Bits first: the vector is the bit pattern the mint actually holds, and
    /// the literal beside it is only there to be read by a human.
    const VECTORS: &[(u64, f64, u64, &str)] = &[
        (
            0x3FF0_0AE9_9FC7_7550,
            1.0026642075893797,
            1_002_664_207,
            "AAPLx multiplier",
        ),
        (
            0x3FF0_0D63_CEDF_2E05,
            1.0032690125398187,
            1_003_269_012,
            "AAPLx newMultiplier",
        ),
        (
            0x3FF0_0000_5087_D7D0,
            1.0000003,
            1_000_000_299,
            "ADR-001 rounding case",
        ),
        (
            0x3FF0_0000_0000_0000,
            1.0,
            1_000_000_000,
            "NFLXx multiplier",
        ),
        (
            0x4024_0000_0000_0000,
            10.0,
            10_000_000_000,
            "NFLXx newMultiplier, the 10-for-1 split",
        ),
        (
            0x3FF0_1003_22A0_0B24,
            1.003909240011759,
            1_003_909_240,
            "SPYx multiplier",
        ),
        (
            0x3FF0_1768_2698_A5D0,
            1.005714560286254,
            1_005_714_560,
            "SPYx newMultiplier",
        ),
        (
            0x3FF0_03C2_AC1B_F43F,
            1.0009180758490996,
            1_000_918_075,
            "NVDAx multiplier",
        ),
        (
            0x3FF0_06F7_D589_FEA9,
            1.001701196801074,
            1_001_701_196,
            "NVDAx newMultiplier",
        ),
    ];

    #[test]
    fn decode_matches_the_spec_vectors() {
        for &(bits, literal, expected, name) in VECTORS {
            assert_eq!(
                f64::from_bits(bits).to_bits(),
                literal.to_bits(),
                "{name}: the hex vector and the decimal literal are different numbers"
            );
            assert_eq!(decode_multiplier_fixed(bits).unwrap(), expected, "{name}");
        }
    }

    /// Independent reference: go through Rust's float formatter instead of the
    /// bit algorithm, take the exact decimal expansion and cut it at nine
    /// places. Two different routes to the same integer.
    #[test]
    fn decode_agrees_with_an_independent_decimal_expansion() {
        for &(bits, _, expected, name) in VECTORS {
            let exact = format!("{:.40}", f64::from_bits(bits));
            let (whole, fraction) = exact.split_once('.').unwrap();
            let floored: u64 = format!("{whole}{}", &fraction[..9]).parse().unwrap();

            assert_eq!(floored, expected, "{name}: reference disagrees ({exact})");
            assert_eq!(decode_multiplier_fixed(bits).unwrap(), floored, "{name}");
        }
    }

    /// ADR-001's whole point. If the decoder were replaced by a float multiply,
    /// this is the vector that would catch it: the others survive truncation.
    #[test]
    fn decode_is_not_a_float_multiply() {
        let bits = 0x3FF0_0000_5087_D7D0; // 1.0000003
        let naive = (f64::from_bits(bits) * MULTIPLIER_SCALE as f64) as u64;

        assert_eq!(
            naive, 1_000_000_300,
            "the naive path no longer overvalues; vector is stale"
        );
        assert_eq!(decode_multiplier_fixed(bits).unwrap(), 1_000_000_299);
    }

    /// Every non-finite pattern, not just the canonical three: quiet and
    /// signalling NaNs carry a payload, and any of them could arrive from a
    /// mint. This widens coverage; it does not make the explicit non-finite
    /// branch load-bearing, because the overflow guard refuses these too.
    #[test]
    fn decode_refuses_every_non_finite_pattern() {
        for payload in [
            0u64,
            1,
            0x7_FFFF_FFFF_FFFF,
            0x8_0000_0000_0000,
            0xF_FFFF_FFFF_FFFF,
        ] {
            for sign in [0u64, SIGN_MASK] {
                let bits = sign | EXPONENT_MASK | payload;

                assert!(
                    decode_multiplier_fixed(bits).is_err(),
                    "non-finite pattern {bits:#018X} was accepted"
                );
            }
        }
    }

    #[test]
    fn decode_refuses_values_that_cannot_be_a_multiplier() {
        let refused: &[(u64, &str)] = &[
            (0x7FF8_0000_0000_0000, "NaN"),
            (0x7FF0_0000_0000_0000, "+Inf"),
            (0xFFF0_0000_0000_0000, "-Inf"),
            (0xBFF0_0000_0000_0000, "-1.0"),
            (0x8000_0000_0000_0000, "-0.0"),
            (0x0000_0000_0000_0000, "0.0"),
            (0x0000_0000_0000_0001, "smallest subnormal"),
            (0x000F_FFFF_FFFF_FFFF, "largest subnormal"),
            (0x7FEF_FFFF_FFFF_FFFF, "f64::MAX, overflows u64 once scaled"),
            (0x7FF8_0000_0000_0001, "signalling NaN"),
        ];

        for &(bits, name) in refused {
            assert!(
                decode_multiplier_fixed(bits).is_err(),
                "{name} was accepted"
            );
        }
    }

    #[test]
    fn decode_accepts_the_largest_multiplier_that_still_fits() {
        // 2^34 scales to 17179869184000000000, inside u64; 2^35 does not.
        assert_eq!(
            decode_multiplier_fixed((2.0f64).powi(34).to_bits()).unwrap(),
            17_179_869_184_000_000_000
        );
        assert!(decode_multiplier_fixed((2.0f64).powi(35).to_bits()).is_err());
    }

    /// A property the vectors cannot express: over the finite positive doubles,
    /// the bit pattern read as an integer is monotonic in the value, so the
    /// decode must never go down as the bits go up.
    #[test]
    fn decode_is_monotonic_across_the_usable_range() {
        let mut previous = 0u64;
        let mut checked = 0u32;

        for step in 0..2_000u64 {
            let bits = 0x3FF0_0000_0000_0000 + step * 0x0000_0001_0000_0000;
            let fixed = decode_multiplier_fixed(bits).unwrap();

            assert!(fixed >= previous, "decode went down at bits {bits:#018X}");
            previous = fixed;
            checked += 1;
        }

        assert_eq!(checked, 2_000);
    }

    #[test]
    fn decode_floors_rather_than_rounds() {
        // The next double above 1.0 is 1 + 2^-52, far below one billionth, so a
        // rounding decoder would still say 1e9 here. Take a value whose ninth
        // decimal place is followed by a long tail instead: 1.0026642075893797
        // is 1.002664207'5893797, and .5 rounds up but floors down.
        let bits = 0x3FF0_0AE9_9FC7_7550;

        assert_eq!(decode_multiplier_fixed(bits).unwrap(), 1_002_664_207);
        assert_ne!(decode_multiplier_fixed(bits).unwrap(), 1_002_664_208);
    }
}
