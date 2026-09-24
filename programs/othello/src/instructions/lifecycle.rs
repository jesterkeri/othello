//! `cancel_circle` and `activate` (T09, SPEC §5).
//!
//! The two ways a Forming circle stops being one. Both are the creator's, and
//! neither moves a token: cancelling sets the status and refunds happen through
//! `withdraw`, which is the same path a completed circle uses. One refund route
//! rather than two is one place for the pro-rata arithmetic to be wrong.

use anchor_lang::prelude::*;

use crate::errors::OthelloError;
use crate::events::{CircleActivated, CircleCancelled};
use crate::state::{Circle, CircleStatus, MAX_MEMBERS};

#[derive(Accounts)]
pub struct CreatorOnly<'info> {
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = creator @ OthelloError::Unauthorized,
    )]
    pub circle: Account<'info, Circle>,
}

/// Forming -> Cancelled. Refunds are `withdraw`'s job (SPEC §7).
pub fn handle_cancel_circle(ctx: Context<CreatorOnly>) -> Result<()> {
    let circle = &mut ctx.accounts.circle;

    require!(
        circle.status == CircleStatus::Forming,
        OthelloError::CircleNotForming
    );

    circle.status = CircleStatus::Cancelled;

    emit!(CircleCancelled {
        circle: circle.key(),
        joined_bitmap: circle.joined_bitmap,
        reserve_total: circle.reserve_total,
    });

    Ok(())
}

/// Forming and everyone joined -> Active, round 0, first deadline set.
pub fn handle_activate(ctx: Context<CreatorOnly>) -> Result<()> {
    let circle = &mut ctx.accounts.circle;

    require!(
        circle.status == CircleStatus::Forming,
        OthelloError::CircleNotForming
    );

    // Every seat, and only the seats that exist. `n` is 3..=8, so a full
    // bitmap for a 5-member circle is 0b11111 and the three unused high bits
    // must stay clear; comparing against u8::MAX would never activate anything
    // smaller than 8.
    let full: u8 = if circle.n as usize >= MAX_MEMBERS {
        u8::MAX
    } else {
        (1u8 << circle.n) - 1
    };
    require!(circle.joined_bitmap == full, OthelloError::NotAllJoined);

    let now = Clock::get()?.unix_timestamp;

    circle.status = CircleStatus::Active;
    circle.round = 0;
    // create_circle bounds round_secs + grace_secs at i64::MAX / 2, so this
    // cannot fail for any real timestamp. It stays checked because the bound
    // lives in another file: if that one is ever relaxed, this must refuse
    // rather than wrap the first deadline into the past. Before the bound
    // existed, round_secs = i64::MAX passed creation, accepted every join, and
    // failed HERE, with everyone's stock already locked.
    circle.round_deadline = now
        .checked_add(circle.round_secs)
        .ok_or(OthelloError::InvalidParams)?;

    emit!(CircleActivated {
        circle: circle.key(),
        round: circle.round,
        round_deadline: circle.round_deadline,
        reserve_total: circle.reserve_total,
    });

    Ok(())
}
