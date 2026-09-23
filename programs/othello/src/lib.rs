//! Othello: an xStock-backed mutual credit circle.
//!
//! Gate 1 scaffold (T01). The instruction surface specified in SPEC §5 arrives
//! task by task: valuation in T02/T03, `init_price_feed`/`set_prices`/
//! `touch_prices` in T04, `quote_valuation` in T05. Nothing is declared here
//! before the task that implements it.

pub mod allowlist;
pub mod errors;
pub mod events;
pub mod gate;
pub mod instructions;
pub mod state;
pub mod valuation;

pub use instructions::*;
pub use state::*;
pub use valuation::Valuation;

use anchor_lang::prelude::*;

// Machine-local program id. PREFLIGHT forbids a keypair file inside the repo,
// so `target/deploy/othello-keypair.json` is generated per clone and is gitignored.
// After a fresh clone, run `anchor keys sync` to bring this line back in step with it.
// The real deploy id is set by Joshua at T23; PREFLIGHT checks the three copies match.
declare_id!("DhZhSvtTh78ZK26MkVVpyeDYr4MuyTZSVrT5YEFqqrDT");

/// Marks a compiled artifact as a harness build.
///
/// `read_clock` logs this literal, so it lands in the program's rodata and
/// `tests/deploy-artifact.spec.ts` can refuse to let such a binary be the
/// deployable one. The incidental strings a harness build also leaves behind,
/// such as Anchor's "Instruction: ReadClock", can be switched off with the
/// `no-log-ix-name` feature; this one is deliberate and cannot.
#[cfg(feature = "harness")]
pub const HARNESS_BUILD_MARKER: &str = "OTHELLO-HARNESS-BUILD-DO-NOT-DEPLOY";

#[program]
pub mod othello {
    use super::*;

    /// A named member's consent: locks stock and deposits the guarantee in one
    /// transaction (T09, SPEC §5). The seat is found by scanning the member
    /// list, never passed in.
    pub fn join_and_lock(ctx: Context<JoinAndLock>, stock_raw: u64) -> Result<()> {
        instructions::join_and_lock::handle_join_and_lock(ctx, stock_raw)
    }

    /// A member pays their contribution for the current round (T10). No time
    /// check: a late payment before a default is declared is a cure.
    pub fn contribute(ctx: Context<Contribute>) -> Result<()> {
        instructions::contribute::handle_contribute(ctx)
    }

    /// Anyone releases the pot once the round is funded and the gate passes
    /// (T10). All n Member accounts come as writable remaining_accounts in
    /// turn order.
    pub fn release_pot<'info>(ctx: Context<'info, ReleasePot<'info>>) -> Result<()> {
        instructions::release_pot::handle_release_pot(ctx)
    }

    /// Anyone recomputes coverage and redistributes the reserve in turn order
    /// (T11). Moves no money. All n Member accounts come as writable
    /// remaining_accounts in turn order.
    pub fn update_coverage<'info>(ctx: Context<'info, UpdateCoverage<'info>>) -> Result<()> {
        instructions::update_coverage::handle_update_coverage(ctx)
    }

    /// Creator only, Forming only. Refunds go through `withdraw` (T09).
    pub fn cancel_circle(ctx: Context<CreatorOnly>) -> Result<()> {
        instructions::lifecycle::handle_cancel_circle(ctx)
    }

    /// Creator only, once every seat has joined (T09).
    pub fn activate(ctx: Context<CreatorOnly>) -> Result<()> {
        instructions::lifecycle::handle_activate(ctx)
    }

    /// Creates the price feed for one stock mint (T04, SPEC §5).
    pub fn init_price_feed(ctx: Context<InitPriceFeed>) -> Result<()> {
        instructions::price_feed::handle_init_price_feed(ctx)
    }

    /// Sets both prices and stamps the multiplier they were quoted for (D5).
    pub fn set_prices(
        ctx: Context<SetPrices>,
        wrapper_price: u64,
        share_price: u64,
        stamp: PriceStamp,
        expected_multiplier_fixed: u64,
    ) -> Result<()> {
        instructions::price_feed::handle_set_prices(
            ctx,
            wrapper_price,
            share_price,
            stamp,
            expected_multiplier_fixed,
        )
    }

    /// Moves `updated_at` and nothing else (I17).
    pub fn touch_prices(ctx: Context<TouchPrices>) -> Result<()> {
        instructions::price_feed::handle_touch_prices(ctx)
    }

    /// Creates a circle in Forming (T08, SPEC §5).
    pub fn create_circle(
        ctx: Context<CreateCircle>,
        params: CircleParams,
        members: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::create_circle::handle_create_circle(ctx, params, members)
    }

    /// Read-only valuation quote: FUND, EXEC and the counted value H (T05).
    pub fn quote_valuation(
        ctx: Context<QuoteValuation>,
        raw: u64,
        haircut_bps: u16,
        max_price_age: i64,
    ) -> Result<Valuation> {
        instructions::quote::handle_quote_valuation(ctx, raw, haircut_bps, max_price_age)
    }

    /// Harness probe for P1: returns the Clock sysvar's `unix_timestamp`.
    ///
    /// Deliberately NOT part of the SPEC §5 instruction surface. It exists so
    /// the harness proof can show that a clock warp is visible to this program
    /// at an exact second.
    ///
    /// The `harness` feature keeps it out of a default build, but a feature gate
    /// governs compilation, not what sits in `target/deploy`: `cargo build-sbf
    /// --features harness` rewrites the .so and leaves the IDL alone. What
    /// enforces "this does not ship" is `tests/deploy-artifact.spec.ts`, which
    /// reads the deployable binary itself and looks for HARNESS_BUILD_MARKER.
    #[cfg(feature = "harness")]
    pub fn read_clock(_ctx: Context<ReadClock>) -> Result<i64> {
        msg!("{}", HARNESS_BUILD_MARKER);
        let now = Clock::get()?.unix_timestamp;
        msg!("clock.unix_timestamp={}", now);
        Ok(now)
    }
}

#[cfg(feature = "harness")]
#[derive(Accounts)]
pub struct ReadClock {}
