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
    #[msg("Only the feed authority can do that")]
    Unauthorized,
    #[msg("Those parameters are outside the allowed range")]
    InvalidParams,
    #[msg("These prices were quoted for a different multiplier than the one in force")]
    MultiplierPriceMismatch,
    #[msg("This price is too old to value collateral with")]
    PriceStale,
    #[msg("That position is too large to value")]
    ValuationOverflow,
    #[msg("That mint is not an accepted xStock")]
    MintNotAllowed,
    #[msg("The guarantee is too small for the worst round this circle can reach")]
    GuaranteeBelowPeakNeed,
    // T09.
    #[msg("This invite is for a different wallet")]
    NotAMember,
    #[msg("This circle already started")]
    CircleNotForming,
    #[msg("That stock is worth less cover than this circle's minimum")]
    CollateralBelowMinimum,
    #[msg("Not everyone has joined yet")]
    NotAllJoined,
    #[msg("That wallet does not hold enough to do this")]
    InsufficientBalance,
    // T10.
    #[msg("You've paid this round")]
    AlreadyContributed,
    #[msg("This circle isn't running right now")]
    CircleNotActive,
    #[msg("This member's default is already settled")]
    AlreadyDefaulted,
    #[msg("Some contributions are still missing")]
    RoundNotFunded,
    #[msg("The recipient's locked stock is below the minimum and is the whole gap")]
    CoverageTooLow,
    #[msg("Payouts are paused: the reserve cannot cover the next payout")]
    ReserveOvercommitted,
    #[msg("The member accounts passed do not match this circle's seats")]
    BadMemberAccounts,
    // T12.
    #[msg("You can withdraw when the circle ends")]
    NotFinished,
    #[msg("You've already withdrawn from this circle")]
    AlreadyWithdrawn,
    // T15.
    #[msg("The grace period for this round has not ended yet")]
    GraceNotElapsed,
    #[msg("That seat has paid this round")]
    SeatAlreadyPaid,
    #[msg("A member can't be defaulted before their turn; they can still pay late")]
    PrePayoutDefaultUnsupported,
    #[msg("The liquidation pool needs refilling before this default can settle")]
    PoolInsufficient,
}
