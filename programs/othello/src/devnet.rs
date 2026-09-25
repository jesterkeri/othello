//! The devnet stand-in mints (S2), used only by a build with `--features devnet`.
//!
//! The real xStocks exist on mainnet only (ADR-012), so a devnet deploy cannot
//! hold them. The devnet build accepts exactly these two mints and nothing
//! else; the mainnet build never accepts either (allowlist.rs).
//!
//! Both are derived from the devnet admin's PUBLIC key with createWithSeed
//! (Joshua, 2026-09-25), so no extra keypair exists and these constants could
//! be written before either mint was created. `ops/devnet-mints.ts` derives
//! the same addresses and `ops/create-devnet-mints.ts` creates them;
//! `tests/s2-devnet-mints.spec.ts` asserts all three agree with
//! `ops/devnet-mints.json`, and the unit test below re-derives them here.
//!
//! Test USDC is Othello's own classic SPL mint, never presented as real USDC.
//! It is replaced by Circle's devnet USDC after the hackathon (TASKS.md).

use anchor_lang::prelude::*;

/// The devnet admin: the deploy wallet, so the program's upgrade authority.
/// Both mints below are derived from it and it is their mint authority.
pub const ADMIN: Pubkey = Pubkey::from_str_const("HXN8oAJFnbaeGLwLdJ129qwSrXUv4xfZ2Em8myu4rciy");

/// NFLXx devnet mirror: Token-2022, 8 decimals, ScaledUiAmountConfig, so the
/// demo can replay the real 10-for-1 split. Always labelled a mirror.
pub const NFLXX_MIRROR: Pubkey =
    Pubkey::from_str_const("CymeZqJiKk2Nd4FkDvHduyrq3k3XbJELtifAbPqfdSuA");

/// Othello test USDC: classic SPL Token, 6 decimals.
pub const TEST_USDC: Pubkey =
    Pubkey::from_str_const("HuNtRYjwPgqKANveLm5vRj9DveBnQAq4cFzWTEf4DoBV");

/// createWithSeed seeds, identical to ops/devnet-mints.ts.
pub const NFLXX_MIRROR_SEED: &str = "othello-nflxx-mirror";
pub const TEST_USDC_SEED: &str = "othello-test-usdc";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_addresses_derive_from_the_admin_and_their_token_program() {
        assert_eq!(
            Pubkey::create_with_seed(&ADMIN, NFLXX_MIRROR_SEED, &anchor_spl::token_2022::ID)
                .unwrap(),
            NFLXX_MIRROR
        );
        assert_eq!(
            Pubkey::create_with_seed(&ADMIN, TEST_USDC_SEED, &anchor_spl::token::ID).unwrap(),
            TEST_USDC
        );
    }

    #[test]
    fn no_stand_in_is_a_mainnet_xstock() {
        for mint in [NFLXX_MIRROR, TEST_USDC] {
            for real in [
                crate::allowlist::AAPLX,
                crate::allowlist::NFLXX,
                crate::allowlist::SPYX,
                crate::allowlist::NVDAX,
            ] {
                assert_ne!(mint, real);
            }
        }
    }
}
