//! Othello: an xStock-backed mutual credit circle.
//!
//! Gate 1 scaffold (T01). The instruction surface specified in SPEC §5 arrives
//! task by task: valuation in T02/T03, `init_price_feed`/`set_prices`/
//! `touch_prices` in T04, `quote_valuation` in T05. Nothing is declared here
//! before the task that implements it.

pub mod errors;
pub mod valuation;

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
    // Used by every instruction from T04 on; today only the harness probe needs it.
    #[cfg(feature = "harness")]
    use super::*;

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
