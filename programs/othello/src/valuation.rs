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
//! Two layers, deliberately separable. `decode_multiplier_fixed` takes raw bits
//! and knows nothing about Token-2022, so it can be tested against bit patterns
//! no mint would ever hold. `effective_multiplier_fixed` sits on top and knows
//! where those bits live in a mint account.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Mint,
};

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

/// The multiplier the Clock selects, as raw IEEE-754 bits (SPEC §9b.1, I13).
///
/// Token-2022 schedules a multiplier change: `multiplier` applies until
/// `new_multiplier_effective_timestamp`, `new_multiplier` from that second on.
/// The boundary is inclusive, matching Token-2022's own `current_multiplier`,
/// which is private and returns an f64. This is the same rule expressed on
/// bits, so the value is never materialised as a float.
///
/// A reader that ignores the timestamp values NFLXx at a tenth of its worth:
/// its `multiplier` field still reads 1 while `new_multiplier` is 10.
pub fn effective_multiplier_bits(config: &ScaledUiAmountConfig, unix_timestamp: i64) -> u64 {
    let effective_at: i64 = config.new_multiplier_effective_timestamp.into();

    let selected = if unix_timestamp >= effective_at {
        config.new_multiplier
    } else {
        config.multiplier
    };

    u64::from_le_bytes(selected.0)
}

/// `floor(effective multiplier × 1e9)` read from a Token-2022 mint account.
///
/// Refuses a mint that will not unpack and a mint with no scaled-UI extension.
/// The second is not pedantry: without it a plain SPL mint, which has no
/// multiplier at all, would have to be given an assumed one, and an assumed
/// multiplier is invented stock data. Which mints are allowed at all is the
/// allowlist's job (ADR-012, T06), not this function's.
pub fn effective_multiplier_fixed(mint_data: &[u8], unix_timestamp: i64) -> Result<u64> {
    let mint = StateWithExtensions::<Mint>::unpack(mint_data)
        .map_err(|_| error!(OthelloError::MultiplierInvalid))?;

    let config = mint
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| error!(OthelloError::MultiplierInvalid))?;

    decode_multiplier_fixed(effective_multiplier_bits(config, unix_timestamp))
}

/// A second reader for the scaled-UI extension, by raw byte offsets.
///
/// Kept as a test only, per TASKS T03: the program uses Token-2022's own
/// `StateWithExtensions`, and this exists so a library upgrade that moved a
/// field or renumbered an extension could not pass silently. Two readers that
/// agree on four real mainnet mints are evidence; one reader is a claim.
#[cfg(test)]
mod tlv_fallback {
    /// Token-2022 pads a mint that carries extensions out to the length of a
    /// token account, writes an account-type byte, then starts the TLV list.
    const ACCOUNT_TYPE_INDEX: usize = 165;
    const TLV_START: usize = 166;
    const ACCOUNT_TYPE_MINT: u8 = 1;

    /// `ExtensionType::Uninitialized`. Token-2022 writes nothing after one of
    /// these and stops searching when it hits one, so a reader that walks past
    /// it can report an extension the program will never see.
    const UNINITIALIZED_TYPE: u16 = 0;

    /// `ExtensionType::ScaledUiAmount`. Hardcoded on purpose, and cross-checked
    /// against the library's own discriminant in the tests: that check is the
    /// whole point of having a second reader.
    pub const SCALED_UI_AMOUNT_TYPE: u16 = 25;
    /// authority(32) + multiplier(8) + effective timestamp(8) + new multiplier(8)
    pub const SCALED_UI_AMOUNT_LEN: u16 = 56;

    const TLV_HEADER_LEN: usize = 4;

    #[derive(Debug, PartialEq, Eq)]
    pub struct ScaledUiAmount {
        pub authority: [u8; 32],
        pub multiplier_bits: u64,
        pub new_multiplier_effective_timestamp: i64,
        pub new_multiplier_bits: u64,
    }

    fn u16_at(data: &[u8], offset: usize) -> Option<u16> {
        Some(u16::from_le_bytes(
            data.get(offset..offset + 2)?.try_into().ok()?,
        ))
    }

    fn u64_at(data: &[u8], offset: usize) -> Option<u64> {
        Some(u64::from_le_bytes(
            data.get(offset..offset + 8)?.try_into().ok()?,
        ))
    }

    /// Walks the TLV list and returns the scaled-UI entry, or None.
    pub fn find(data: &[u8]) -> Option<ScaledUiAmount> {
        if *data.get(ACCOUNT_TYPE_INDEX)? != ACCOUNT_TYPE_MINT {
            return None;
        }

        let mut offset = TLV_START;

        while offset + TLV_HEADER_LEN <= data.len() {
            let entry_type = u16_at(data, offset)?;

            if entry_type == UNINITIALIZED_TYPE {
                return None;
            }

            let entry_len = u16_at(data, offset + 2)? as usize;
            let value = offset + TLV_HEADER_LEN;

            if entry_type == SCALED_UI_AMOUNT_TYPE {
                if entry_len != SCALED_UI_AMOUNT_LEN as usize {
                    return None;
                }

                return Some(ScaledUiAmount {
                    authority: data.get(value..value + 32)?.try_into().ok()?,
                    multiplier_bits: u64_at(data, value + 32)?,
                    new_multiplier_effective_timestamp: u64_at(data, value + 40)? as i64,
                    new_multiplier_bits: u64_at(data, value + 48)?,
                });
            }

            offset = value + entry_len;
        }

        None
    }
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

    // ---- T03: reading the multiplier out of a real mint account ----

    /// The four committed mainnet fixtures (SPEC §9b.1), as the T00 fetcher
    /// wrote them.
    const FIXTURES: [&str; 4] = ["AAPLx", "NFLXx", "SPYx", "NVDAx"];

    fn fixture(symbol: &str) -> serde_json::Value {
        let path = format!(
            "{}/../../tests/fixtures/{symbol}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));

        serde_json::from_str(&raw).unwrap()
    }

    fn mint_bytes(symbol: &str) -> Vec<u8> {
        use base64::Engine as _;

        let encoded = fixture(symbol)["dataBase64"].as_str().unwrap().to_owned();

        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap()
    }

    fn official_config(data: &[u8]) -> ScaledUiAmountConfig {
        *StateWithExtensions::<Mint>::unpack(data)
            .unwrap()
            .get_extension::<ScaledUiAmountConfig>()
            .unwrap()
    }

    /// The point of keeping a second reader: Token-2022's own parser and a walk
    /// of the raw TLV bytes must see the same extension, on every real mint.
    #[test]
    fn t03_both_parsers_agree_on_the_real_fixtures() {
        for symbol in FIXTURES {
            let data = mint_bytes(symbol);
            let official = official_config(&data);
            let manual = tlv_fallback::find(&data).unwrap_or_else(|| {
                panic!("{symbol}: the byte reader found no scaled-UI extension")
            });

            assert_eq!(
                manual.authority,
                Into::<Option<Pubkey>>::into(official.authority)
                    .unwrap()
                    .to_bytes(),
                "{symbol}: authority"
            );
            assert_eq!(
                manual.multiplier_bits,
                u64::from_le_bytes(official.multiplier.0),
                "{symbol}: multiplier"
            );
            assert_eq!(
                manual.new_multiplier_effective_timestamp,
                Into::<i64>::into(official.new_multiplier_effective_timestamp),
                "{symbol}: effective timestamp"
            );
            assert_eq!(
                manual.new_multiplier_bits,
                u64::from_le_bytes(official.new_multiplier.0),
                "{symbol}: new multiplier"
            );
        }
    }

    /// A third source: the values the T00 fetcher recorded alongside the bytes.
    /// If the bytes and the record ever disagree, one of them is not what the
    /// chain returned.
    #[test]
    fn t03_agrees_with_the_values_recorded_in_the_fixture_json() {
        for symbol in FIXTURES {
            let recorded = fixture(symbol)["decodedScaledUiAmountConfig"].clone();
            let config = official_config(&mint_bytes(symbol));

            assert_eq!(
                u64::from_le_bytes(config.multiplier.0),
                recorded["multiplier"].as_f64().unwrap().to_bits(),
                "{symbol}: multiplier"
            );
            assert_eq!(
                u64::from_le_bytes(config.new_multiplier.0),
                recorded["newMultiplier"].as_f64().unwrap().to_bits(),
                "{symbol}: newMultiplier"
            );
            assert_eq!(
                Into::<i64>::into(config.new_multiplier_effective_timestamp).to_string(),
                recorded["newMultiplierEffectiveTimestamp"]
                    .as_str()
                    .unwrap(),
                "{symbol}: newMultiplierEffectiveTimestamp"
            );
        }
    }

    /// The byte reader hardcodes the extension discriminant. If a Token-2022
    /// upgrade renumbered it, the two readers would quietly stop describing the
    /// same thing, so pin the hardcoded value to the library's own.
    #[test]
    fn t03_hardcoded_extension_type_matches_the_library() {
        use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;

        assert_eq!(
            tlv_fallback::SCALED_UI_AMOUNT_TYPE,
            ExtensionType::ScaledUiAmount as u16
        );
        assert_eq!(
            tlv_fallback::SCALED_UI_AMOUNT_LEN as usize,
            core::mem::size_of::<ScaledUiAmountConfig>()
        );
    }

    /// SPEC §10 G1, on the real bytes: NFLXx is a real 10-for-1 split, and its
    /// `multiplier` field still reads 1. A reader that ignores the effective
    /// timestamp values it at a tenth.
    #[test]
    fn t03_clock_selects_the_multiplier_at_the_exact_second() {
        let nflx = mint_bytes("NFLXx");

        assert_eq!(
            effective_multiplier_fixed(&nflx, 1_763_337_299).unwrap(),
            1_000_000_000,
            "one second before the split"
        );
        assert_eq!(
            effective_multiplier_fixed(&nflx, 1_763_337_300).unwrap(),
            10_000_000_000,
            "the split second itself: the boundary is inclusive"
        );

        let aapl = mint_bytes("AAPLx");

        assert_eq!(
            effective_multiplier_fixed(&aapl, 1_786_148_999).unwrap(),
            1_002_664_207,
            "AAPLx before its scheduled change"
        );
        assert_eq!(
            effective_multiplier_fixed(&aapl, 1_786_149_000).unwrap(),
            1_003_269_012,
            "AAPLx at its scheduled change"
        );
    }

    /// Every fixture, at both sides of its own boundary, against the recorded
    /// values rather than against hand-written expectations.
    #[test]
    fn t03_selects_across_the_boundary_for_every_fixture() {
        for symbol in FIXTURES {
            let data = mint_bytes(symbol);
            let config = official_config(&data);
            let effective_at: i64 = config.new_multiplier_effective_timestamp.into();

            let before = decode_multiplier_fixed(u64::from_le_bytes(config.multiplier.0)).unwrap();
            let after =
                decode_multiplier_fixed(u64::from_le_bytes(config.new_multiplier.0)).unwrap();

            assert_eq!(
                effective_multiplier_fixed(&data, effective_at - 1).unwrap(),
                before,
                "{symbol}: one second early"
            );
            assert_eq!(
                effective_multiplier_fixed(&data, effective_at).unwrap(),
                after,
                "{symbol}: on the second"
            );
        }
    }

    /// From the adversary pass on 118ba66. Token-2022 stops its TLV walk at an
    /// Uninitialized entry; the byte reader walked past it, so on these bytes
    /// the program refused the mint while the reader that exists to corroborate
    /// the program reported a multiplier.
    #[test]
    fn t03_both_readers_agree_on_a_mint_with_an_uninitialized_tlv_entry() {
        /// Offset of the ScaledUiAmount TLV header in the real AAPLx fixture.
        const SCALED_UI_HEADER: usize = 275;

        let mut data = mint_bytes("AAPLx");

        assert_eq!(
            u16::from_le_bytes(
                data[SCALED_UI_HEADER..SCALED_UI_HEADER + 2]
                    .try_into()
                    .unwrap()
            ),
            tlv_fallback::SCALED_UI_AMOUNT_TYPE,
            "the AAPLx fixture no longer carries its scaled-UI entry at {SCALED_UI_HEADER}"
        );

        data.splice(SCALED_UI_HEADER..SCALED_UI_HEADER, [0u8, 0, 0, 0]);

        assert_eq!(
            tlv_fallback::find(&data).is_some(),
            effective_multiplier_fixed(&data, 0).is_ok(),
            "the two readers disagree on the same bytes"
        );
    }

    /// Builds a TLV buffer by hand, with a sentinel in every field, on a mint
    /// base Token-2022 itself refuses because it is not initialised.
    ///
    /// This is what makes the second reader a second reader. Field order inside
    /// the 56 bytes was otherwise only covered by comparing the two readers on
    /// real fixtures, and that comparison cannot tell an independent reader from
    /// one that delegates to `StateWithExtensions`: both agree trivially. Here
    /// the official parser refuses and the byte reader must still produce the
    /// four values, each distinct, so a delegating implementation fails and so
    /// does any permutation of the fields.
    #[test]
    fn t03_the_byte_reader_parses_fields_the_official_parser_never_sees() {
        const AUTHORITY: [u8; 32] = [0xAA; 32];
        const MULTIPLIER_BITS: u64 = 0x3FF0_0000_0000_0000; // 1.0
        const EFFECTIVE_AT: i64 = 1_234_567_890;
        const NEW_MULTIPLIER_BITS: u64 = 0x4024_0000_0000_0000; // 10.0

        let mut data = vec![0u8; 165];
        data.push(1); // account type: Mint
        data.extend_from_slice(&tlv_fallback::SCALED_UI_AMOUNT_TYPE.to_le_bytes());
        data.extend_from_slice(&tlv_fallback::SCALED_UI_AMOUNT_LEN.to_le_bytes());
        data.extend_from_slice(&AUTHORITY);
        data.extend_from_slice(&MULTIPLIER_BITS.to_le_bytes());
        data.extend_from_slice(&EFFECTIVE_AT.to_le_bytes());
        data.extend_from_slice(&NEW_MULTIPLIER_BITS.to_le_bytes());

        assert!(
            effective_multiplier_fixed(&data, 0).is_err(),
            "the base is all zeroes, so Token-2022 must refuse it as uninitialised"
        );

        let read = tlv_fallback::find(&data).expect("the byte reader found nothing");

        assert_eq!(read.authority, AUTHORITY, "authority");
        assert_eq!(read.multiplier_bits, MULTIPLIER_BITS, "multiplier");
        assert_eq!(
            read.new_multiplier_effective_timestamp, EFFECTIVE_AT,
            "effective timestamp"
        );
        assert_eq!(
            read.new_multiplier_bits, NEW_MULTIPLIER_BITS,
            "new multiplier"
        );
    }

    /// The byte reader's own refusals, each load-bearing: without them it would
    /// read an extension out of bytes that are not a mint, or out of an entry
    /// whose declared length says it is something else.
    #[test]
    fn t03_the_byte_reader_refuses_a_malformed_tlv() {
        let good = mint_bytes("AAPLx");
        const SCALED_UI_HEADER: usize = 275;

        let mut wrong_account_type = good.clone();
        wrong_account_type[165] = 2; // Account, not Mint
        assert!(
            tlv_fallback::find(&wrong_account_type).is_none(),
            "read an extension out of something that is not a mint"
        );

        for declared in [55u16, 57] {
            let mut wrong_length = good.clone();
            wrong_length[SCALED_UI_HEADER + 2..SCALED_UI_HEADER + 4]
                .copy_from_slice(&declared.to_le_bytes());

            assert!(
                tlv_fallback::find(&wrong_length).is_none(),
                "accepted a scaled-UI entry declaring {declared} bytes"
            );
        }
    }

    #[test]
    fn t03_refuses_a_mint_with_no_scaled_ui_extension() {
        // The first 82 bytes of a real mint are a valid plain SPL mint with no
        // extensions at all. It has no multiplier, and inventing one for it
        // would be invented stock data.
        let plain = &mint_bytes("AAPLx")[..82];

        assert!(effective_multiplier_fixed(plain, 0).is_err());
        assert!(tlv_fallback::find(plain).is_none());
    }

    #[test]
    fn t03_refuses_bytes_that_are_not_a_mint() {
        for bad in [vec![], vec![0u8; 10], vec![0xFF; 400]] {
            assert!(
                effective_multiplier_fixed(&bad, 0).is_err(),
                "{} bytes of rubbish were accepted",
                bad.len()
            );
        }
    }

    /// Multipliers below 1, which a reverse split writes: the mirror of the
    /// real NFLXx 10-for-1 that SPEC 9b.1 is built around. The committed suite
    /// had no accepted vector under 1.0 until the adversary pass on 3b1c74d,
    /// which meant a decoder that ceiled everywhere below 1, ADR-001's
    /// overvaluation defect exactly, passed every test.
    ///
    /// Computed on exact rationals, not with this decoder.
    const BELOW_ONE_VECTORS: &[(u64, f64, u64, &str)] = &[
        (
            0x3FB9_9999_9999_999A,
            0.1,
            100_000_000,
            "0.1, a 1-for-10 reverse split; the double is above 0.1, so ceil would say 100000001",
        ),
        (
            0x3F50_624D_D2F1_A9FC,
            0.001,
            1_000_000,
            "0.001, a 1-for-1000 reverse split",
        ),
        (
            0x3EB0_C6F7_A0B5_ED8D,
            1e-6,
            999,
            "1e-6; the double is below 1e-6, so a float multiply overvalues to 1000",
        ),
        (
            0x3FEF_FFFF_FFF2_4190,
            0.9999999999,
            999_999_999,
            "just under 1.0, where ceil would reach the scale itself",
        ),
        (
            0x3FE0_0000_0000_0000,
            0.5,
            500_000_000,
            "0.5, exactly representable, so floor and ceil agree",
        ),
        (
            0x3E11_2E0B_E826_D695,
            1e-9,
            1,
            "1e-9, the smallest multiplier that is not refused",
        ),
    ];

    fn every_vector() -> impl Iterator<Item = &'static (u64, f64, u64, &'static str)> {
        VECTORS.iter().chain(BELOW_ONE_VECTORS.iter())
    }

    #[test]
    fn decode_matches_the_spec_vectors() {
        for &(bits, literal, expected, name) in every_vector() {
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
        for &(bits, _, expected, name) in every_vector() {
            // 1100 places, not 40: a binary64's decimal expansion terminates
            // within 1074 fractional digits, so at this precision the formatter
            // is exact and pads with zeros. Cutting a ROUNDED expansion is
            // unsound, because a run of nines past the cut carries into digit 9
            // and accuses a correct decoder. 1e-6 has thirteen such nines.
            let exact = format!("{:.1100}", f64::from_bits(bits));
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
    /// ADR-001's failure below 1. The double nearest 1e-6 is just under it, but
    /// `1e-6_f64 * 1e9` rounds to exactly 1000.0, so even a truncating cast
    /// overvalues by a whole unit.
    #[test]
    fn decode_is_not_a_float_multiply_below_one() {
        let bits = 0x3EB0_C6F7_A0B5_ED8D; // 1e-6
        let naive = (f64::from_bits(bits) * MULTIPLIER_SCALE as f64) as u64;

        assert_eq!(
            naive, 1_000,
            "the naive path no longer overvalues; vector is stale"
        );
        assert_eq!(decode_multiplier_fixed(bits).unwrap(), 999);
    }

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
            (
                0x3E11_0210_E863_E3CC,
                "9.9e-10, just under the smallest accepted multiplier",
            ),
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
