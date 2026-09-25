//! The xStock mint allowlist (ADR-012).
//!
//! Collateral is identified by mint ADDRESS, never by symbol: Jupiter returns
//! five tokens named NFLXx and one of them is real. A symbol is a string its
//! creator chose; an address is not.
//!
//! Hardcoded rather than admin-managed, per ADR-012 and OPEN-QUESTIONS. An
//! admin-managed list would be one more thing the demo admin key could do, and
//! SPEC's threat model already accepts that key only for prices and the pool.
//!
//! These four are the mainnet addresses recorded in SPEC §9b.1. They are also
//! in `ops/xstock-mints.ts`, which the fixture fetcher reads, and
//! `tests/t06-allowlist.spec.ts` asserts the two lists are identical so they
//! cannot drift apart.

use anchor_lang::prelude::*;

/// Apple, SPEC §9b.1.
pub const AAPLX: Pubkey = Pubkey::from_str_const("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp");
/// Netflix, SPEC §9b.1. The real 10-for-1 split the gate is built around.
pub const NFLXX: Pubkey = Pubkey::from_str_const("XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL");
/// S&P 500, SPEC §9b.1.
pub const SPYX: Pubkey = Pubkey::from_str_const("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
/// NVIDIA, SPEC §9b.1.
pub const NVDAX: Pubkey = Pubkey::from_str_const("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");

/// Every mint Othello will accept as collateral.
#[cfg(not(feature = "devnet"))]
pub const ALLOWED_STOCK_MINTS: [Pubkey; 4] = [AAPLX, NFLXX, SPYX, NVDAX];

/// The devnet build (S2) accepts the NFLXx devnet mirror and nothing else: the
/// real xStocks do not exist on devnet, and a build that accepted both lists
/// could let a devnet mint stand in for a real one. See devnet.rs.
#[cfg(feature = "devnet")]
pub const ALLOWED_STOCK_MINTS: [Pubkey; 1] = [crate::devnet::NFLXX_MIRROR];

pub fn is_allowed(mint: &Pubkey) -> bool {
    // Four entries, compared as 32-byte arrays. A linear scan is the whole cost.
    ALLOWED_STOCK_MINTS.iter().any(|allowed| allowed == mint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(feature = "devnet"))]
    fn allowlist_holds_exactly_the_four_spec_mints() {
        assert_eq!(ALLOWED_STOCK_MINTS.len(), 4);

        for mint in ALLOWED_STOCK_MINTS {
            assert!(is_allowed(&mint), "{mint} is in the list but not allowed");
        }
    }

    #[test]
    fn allowlist_refuses_everything_else() {
        assert!(
            !is_allowed(&Pubkey::default()),
            "the zero address was allowed"
        );
        assert!(!is_allowed(&crate::ID), "the program itself was allowed");

        // One character different from NFLXx, and still refused.
        let near_miss = Pubkey::from_str_const("XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpM");
        assert!(!is_allowed(&near_miss), "a near-miss address was allowed");
    }

    #[test]
    #[cfg(not(feature = "devnet"))]
    fn mainnet_build_refuses_both_devnet_stand_ins() {
        assert!(!is_allowed(&crate::devnet::NFLXX_MIRROR));
        assert!(!is_allowed(&crate::devnet::TEST_USDC));
    }

    #[test]
    #[cfg(feature = "devnet")]
    fn devnet_build_accepts_only_the_nflxx_mirror() {
        assert_eq!(ALLOWED_STOCK_MINTS, [crate::devnet::NFLXX_MIRROR]);
        assert!(is_allowed(&crate::devnet::NFLXX_MIRROR));
        assert!(
            !is_allowed(&crate::devnet::TEST_USDC),
            "test USDC is not collateral"
        );
        for real in [AAPLX, NFLXX, SPYX, NVDAX] {
            assert!(
                !is_allowed(&real),
                "{real} is a mainnet mint in a devnet build"
            );
        }
    }
}
