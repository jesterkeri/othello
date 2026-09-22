use anchor_lang::prelude::*;

/// Refusal codes from SPEC §5, with the copy from SPEC §9.
///
/// APPEND ONLY. Anchor numbers these by declaration order (6000 + index) and
/// that number is what a client sees on chain, so inserting a variant silently
/// renumbers every one after it. Each task adds the codes it implements to the
/// end.
#[error_code]
pub enum OthelloError {
    #[msg("This stock's multiplier can't be read safely")]
    MultiplierInvalid,
}
