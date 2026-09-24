//! `release_pot` (T10, SPEC §5 and the "Payout gate" block).
//!
//! Callable by ANYONE once the round is funded (FLOWS D4). The recipient does
//! not have to be online, which deletes the "recipient must claim" branch and,
//! with it, a circle that stalls because someone is asleep.
//!
//! The gate is the load-bearing part. It asks one question: if this pot goes
//! out, is every remaining obligation in the circle still covered? A payout
//! that leaves the circle unable to cover what it now owes has not moved money,
//! it has moved the loss onto whoever is later in the order.
//!
//! All n Member accounts arrive as writable `remaining_accounts` in turn order.
//! Each is validated against its seat: passing someone else's Member, or the
//! same one twice, is what a caller would try if they wanted the gate summed
//! over a friendlier set of people.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::{PotRefused, PotReleased, RoundNotFunded};
use crate::gate::{coverage_bps, need, obligations, obligations_next_round, short_by, GateOutcome};
use crate::state::{Circle, CircleStatus, Member, PriceFeed};
use crate::valuation::value_position;

#[derive(Accounts)]
pub struct ReleasePot<'info> {
    /// Anyone. Pays rent if the recipient has no USDC account yet, which is
    /// why `join_and_lock` creates one: so this almost never has to.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = stock_mint,
        has_one = usdc_mint,
        has_one = price_feed,
    )]
    pub circle: Box<Account<'info, Circle>>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [PriceFeed::SEED, stock_mint.key().as_ref()],
        bump = price_feed.bump,
        has_one = stock_mint,
    )]
    pub price_feed: Box<Account<'info, PriceFeed>>,

    /// CHECK: constrained in the handler to `circle.members[circle.round]`. It
    /// is only ever an ATA authority, never a signer and never written.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = usdc_mint,
        associated_token::authority = recipient,
        associated_token::token_program = usdc_token_program,
    )]
    pub recipient_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = circle,
        associated_token::token_program = usdc_token_program,
    )]
    pub circle_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// One member's position as the gate sees it.
struct Seat {
    turn: u8,
    received: bool,
    defaulted: bool,
    stock_cover: u64,
    obligations: u64,
    need: u64,
}

pub fn handle_release_pot<'info>(ctx: Context<'info, ReleasePot<'info>>) -> Result<()> {
    let circle = &ctx.accounts.circle;

    require!(
        circle.status == CircleStatus::Active,
        OthelloError::CircleNotActive
    );

    let n = circle.n;
    let round = circle.round;

    require!(
        ctx.accounts.recipient.key() == circle.members[round as usize],
        OthelloError::BadMemberAccounts
    );

    // Exactly n Member accounts, in turn order. Anything else and the gate
    // would be summed over a set the caller chose.
    require!(
        ctx.remaining_accounts.len() == n as usize,
        OthelloError::BadMemberAccounts
    );

    let now = Clock::get()?.unix_timestamp;

    // Every seat must be paid, or defaulted with the escrow standing in for it.
    // I6: the pot is released only when every seat is funded one way or other.
    let mut escrow_owed: u64 = 0;
    let mut missing_seats: u8 = 0;
    for turn in 0..n {
        let bit = 1u8 << turn;
        let paid = circle.paid_bitmap & bit != 0;
        let defaulted = circle.defaulted_bitmap & bit != 0;

        if paid {
            continue;
        }
        if !defaulted {
            missing_seats |= bit;
            continue;
        }

        escrow_owed = escrow_owed
            .checked_add(circle.contribution)
            .ok_or(OthelloError::ValuationOverflow)?;
    }

    // SPEC.md:204 and :106. The whole payload, before the error, so a simulated
    // refusal tells the UI which seats are missing rather than only that some
    // are. The loop runs to completion first for the same reason: reporting the
    // first unpaid seat would understate the ask.
    if missing_seats != 0 || circle.escrow < escrow_owed {
        emit!(RoundNotFunded {
            circle: circle.key(),
            round,
            missing_seats,
            escrow: circle.escrow,
            escrow_needed: escrow_owed,
            escrow_deficit: circle.escrow_deficit,
            short_by: circle.next_gate_short_by,
        });
        return err!(OthelloError::RoundNotFunded);
    }

    // Read every seat once. value_position enforces freshness and the D5 stamp
    // match, so a stale or repricing feed refuses the payout here rather than
    // paying against a price nobody vouched for.
    let mut members: Vec<Account<'info, Member>> = Vec::with_capacity(n as usize);
    let mut seats: Vec<Seat> = Vec::with_capacity(n as usize);

    {
        let mint_info = ctx.accounts.stock_mint.to_account_info();
        let mint_data = mint_info.try_borrow_data()?;

        for (index, info) in ctx.remaining_accounts.iter().enumerate() {
            // Not a Member account at all is bad_member_accounts too, as in
            // load_members (Gate 3 r1).
            let member: Account<'info, Member> =
                Account::try_from(info).map_err(|_| error!(OthelloError::BadMemberAccounts))?;

            require!(
                member.circle == circle.key() && member.turn as usize == index,
                OthelloError::BadMemberAccounts
            );
            require!(info.is_writable, OthelloError::BadMemberAccounts);

            let turn = member.turn;
            let bit = 1u8 << turn;
            let defaulted = circle.defaulted_bitmap & bit != 0;
            // SPEC's gate: treat the recipient as received, because after this
            // payout they are, and it is their obligations the circle must be
            // able to stand behind.
            let received = circle.received_bitmap & bit != 0 || turn == round;

            let stock_cover = if defaulted {
                0
            } else {
                value_position(
                    &ctx.accounts.price_feed,
                    &mint_data,
                    member.stock_raw,
                    circle.haircut_bps,
                    now,
                    circle.max_price_age,
                )?
                .h
            };

            let o = if defaulted {
                0
            } else {
                obligations(circle.contribution, n, member.rounds_paid, received)?
            };
            let need_i = need(o, stock_cover, circle.coverage_bps)?;

            seats.push(Seat {
                turn,
                received,
                defaulted,
                stock_cover,
                obligations: o,
                need: need_i,
            });
            members.push(member);
        }
    }

    // The gate. S over received, non-defaulted members; avail is R - L, which
    // SPEC.md:126 calls `remaining` and is NOT the free figure the UI shows.
    let mut needed: u64 = 0;
    for seat in &seats {
        if seat.defaulted || !seat.received {
            continue;
        }
        needed = needed
            .checked_add(seat.need)
            .ok_or(OthelloError::ValuationOverflow)?;
    }

    let remaining = circle.reserve_remaining();
    let recipient_seat = seats
        .iter()
        .find(|s| s.turn == round)
        .ok_or(OthelloError::BadMemberAccounts)?;

    let outcome = GateOutcome {
        needed,
        remaining,
        recipient_gap: recipient_seat.need,
        recipient_cover: recipient_seat.stock_cover,
        escrow_deficit: circle.escrow_deficit,
    };

    if !outcome.passes() {
        // SPEC.md:204: the payload is an EVENT, not a log line. Both reach the
        // client through the same transaction logs, but an event is typed and
        // in the IDL, and a log line is free text nothing protects.
        let refusal = outcome.refusal(circle.min_stock_cover);

        emit!(PotRefused {
            circle: circle.key(),
            round,
            recipient: ctx.accounts.recipient.key(),
            needed: outcome.needed,
            remaining: outcome.remaining,
            short_by: outcome.short_by(),
            recipient_gap: outcome.recipient_gap,
            others_need: outcome.others_need(),
            recipient_cover: outcome.recipient_cover,
            escrow_deficit: outcome.escrow_deficit,
            coverage_too_low: matches!(refusal, OthelloError::CoverageTooLow),
        });

        return Err(refusal.into());
    }

    let pot = circle
        .contribution
        .checked_mul(n as u64)
        .ok_or(OthelloError::ValuationOverflow)?;

    // Pay before touching state, so a failed transfer cannot leave a circle
    // that believes it paid.
    let creator = circle.creator;
    let circle_id = circle.circle_id.to_le_bytes();
    let bump = circle.bump;
    let seeds: &[&[u8]] = &[Circle::SEED, creator.as_ref(), &circle_id, &[bump]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.usdc_token_program.key(),
            TransferChecked {
                from: ctx.accounts.circle_usdc_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.recipient_usdc_ata.to_account_info(),
                authority: ctx.accounts.circle.to_account_info(),
            },
            &[seeds],
        ),
        pot,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // I2: the allocations the gate summed are exactly what is recorded, so
    // Sigma Member.allocated equals Circle.reserve_allocated afterwards.
    for (member, seat) in members.iter_mut().zip(seats.iter()) {
        if seat.defaulted || !seat.received {
            member.allocated = 0;
            member.last_coverage_bps = coverage_bps(seat.stock_cover, 0, seat.obligations);
        } else {
            member.allocated = seat.need;
            member.last_coverage_bps = coverage_bps(seat.stock_cover, seat.need, seat.obligations);
        }

        // A defaulted seat's missed contribution is paid out of escrow, and
        // that counts as a round paid for the purpose of what they still owe.
        if circle.paid_bitmap & (1u8 << seat.turn) == 0 && seat.defaulted {
            member.rounds_paid = member
                .rounds_paid
                .checked_add(1)
                .ok_or(OthelloError::ValuationOverflow)?;
        }

        member.exit(&crate::ID)?;
    }

    let circle = &mut ctx.accounts.circle;

    circle.escrow = circle
        .escrow
        .checked_sub(escrow_owed)
        .ok_or(OthelloError::ValuationOverflow)?;
    // SPEC §5 sets the paid bit for each escrow-covered defaulted seat here.
    // It was written and is now gone, because `paid_bitmap = 0` four lines
    // below zeroes the whole thing for the new round: the writes could never be
    // read, and dead state writes read as live ones to whoever comes next. The
    // part of that clause that DOES outlive the round is rounds_paid++, which
    // happens on the Member above.

    circle.reserve_allocated = needed;
    circle.received_bitmap |= 1u8 << round;
    circle.held_contributions = 0;
    circle.paid_bitmap = 0;

    // I10: exactly n payouts, then Completed. The round only ever advances
    // here, so there is one place that can miscount it.
    let payouts = (0..n)
        .filter(|t| circle.received_bitmap & (1u8 << t) != 0)
        .count();
    if payouts >= n as usize {
        circle.status = CircleStatus::Completed;
        circle.next_gate_short_by = 0;
        circle.round_deadline = now;
    } else {
        circle.round = round
            .checked_add(1)
            .ok_or(OthelloError::ValuationOverflow)?;
        circle.round_deadline = now
            .checked_add(circle.round_secs)
            .ok_or(OthelloError::InvalidParams)?;

        // next_gate_short_by for the round that just opened. SPEC §5 (r4): this
        // uses c x (n - round - 1) for every received non-defaulted member,
        // never their stored rounds_paid, because it describes a gate that has
        // not run yet.
        let mut next_needed: u64 = 0;
        for seat in &seats {
            let is_recipient_now = seat.turn == circle.round;
            if seat.defaulted || !(seat.received || is_recipient_now) {
                continue;
            }
            // Same H for everyone in the sum: prices have not moved inside
            // this instruction, and SPEC is explicit that only the obligation
            // side is projected forward.
            let o = obligations_next_round(circle.contribution, n, circle.round)?;
            next_needed = next_needed
                .checked_add(need(o, seat.stock_cover, circle.coverage_bps)?)
                .ok_or(OthelloError::ValuationOverflow)?;
        }
        circle.next_gate_short_by = short_by(
            next_needed,
            circle.reserve_remaining(),
            circle.escrow_deficit,
        );
    }

    circle.last_coverage_at = now;

    emit!(PotReleased {
        circle: circle.key(),
        round,
        recipient: ctx.accounts.recipient.key(),
        pot,
        needed,
        remaining,
        reserve_allocated: circle.reserve_allocated,
        next_gate_short_by: circle.next_gate_short_by,
        completed: circle.status == CircleStatus::Completed,
    });

    Ok(())
}
