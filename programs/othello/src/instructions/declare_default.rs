//! `declare_default(turn)` (T15, SPEC §5 row and §6 waterfall).
//!
//! Anyone may declare a default once a seat has missed its contribution past
//! the deadline plus grace. That seat's member has already received their pot,
//! so they are holding the circle's money, and their collateral is what stands
//! behind the rounds they still owe. The waterfall settles those rounds in one
//! instruction, so no member later in the order is left owed:
//!
//!   1. Sell only what is owed. The defaulter's stock goes to the liquidation
//!      pool at the conservative price, wrapper x (1 - discount), and no more
//!      of it than covers their remaining obligation (I9). The rest stays theirs
//!      and comes back at withdraw.
//!   2. What the stock does not cover comes from the reserve, as a loss.
//!   3. What the reserve cannot cover is an escrow deficit, which a top-up
//!      cures (I14) and which shows as Paused until it is.
//!
//! The escrow then pays the defaulted seat's contribution each round, in
//! `release_pot`, until the circle completes.
//!
//! SPEC §6 values the stock on the NON-scaled wrapper price only, so this works
//! while a split is being repriced (I13). What it cannot do then is value
//! anyone's position through the multiplier, so the recompute afterwards takes
//! the capped branch described on the SPEC row instead.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::OthelloError;
use crate::events::DefaultDeclared;
use crate::instructions::update_coverage::{load_members, recompute_coverage};
use crate::state::{Circle, CircleStatus, LiquidationPool, PriceFeed};
use crate::valuation::{
    decode_multiplier_fixed, effective_multiplier_bits, scaled_ui_config, BPS_DENOMINATOR,
    RAW_PER_TOKEN,
};

#[derive(Accounts)]
pub struct DeclareDefault<'info> {
    /// Anyone. Nothing is created, so the caller pays only the fee.
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [Circle::SEED, circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump,
        has_one = stock_mint,
        has_one = usdc_mint,
        has_one = price_feed,
        has_one = pool,
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

    #[account(
        seeds = [LiquidationPool::SEED, usdc_mint.key().as_ref(), stock_mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LiquidationPool>>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = circle,
        associated_token::token_program = stock_token_program,
    )]
    pub circle_stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = circle,
        associated_token::token_program = usdc_token_program,
    )]
    pub circle_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = pool,
        associated_token::token_program = stock_token_program,
    )]
    pub pool_stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool,
        associated_token::token_program = usdc_token_program,
    )]
    pub pool_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub stock_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

/// SPEC §6, the arithmetic only, so it can be tested without a transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Waterfall {
    /// `O = contribution x (n - rounds_paid_d)`, including the missed round.
    pub obligations: u64,
    pub sell_raw: u64,
    pub recovered: u64,
    pub funded_from_stock: u64,
    pub shortfall: u64,
    pub loss: u64,
    /// `shortfall - loss`, added to `escrow_deficit`.
    pub deficit: u64,
    /// `min(shortfall, guarantee_d + top_ups_d)`, the r3 measure.
    pub forfeited: u64,
}

pub struct WaterfallInput {
    pub contribution: u64,
    pub n: u8,
    pub rounds_paid: u8,
    pub stock_raw: u64,
    pub wrapper_price: u64,
    pub discount_bps: u16,
    /// `reserve_total - reserve_losses`, what the reserve can still absorb.
    pub reserve_available: u64,
    pub guarantee: u64,
    pub top_ups: u64,
}

pub fn waterfall(input: &WaterfallInput) -> Result<Waterfall> {
    let owed_rounds = (input.n as u64)
        .checked_sub(input.rounds_paid as u64)
        .ok_or(OthelloError::ValuationOverflow)?;
    let obligations = input
        .contribution
        .checked_mul(owed_rounds)
        .ok_or(OthelloError::ValuationOverflow)?;

    // conservative = wrapper_price x (10000 - discount_bps) / 10000, USDC per
    // whole token. init_pool guarantees discount_bps < 10000.
    let conservative = (input.wrapper_price as u128)
        .checked_mul(BPS_DENOMINATOR.saturating_sub(input.discount_bps as u64) as u128)
        .ok_or(OthelloError::ValuationOverflow)?
        / BPS_DENOMINATOR as u128;

    // sell_raw = min(stock_raw, ceil(O x 1e8 / conservative)). Ceiling so the
    // sale covers O; the min so nothing beyond the defaulter's own stock is
    // ever sold. A conservative price of zero buys nothing at any quantity, so
    // selling would take stock and return no money: nothing is sold, and the
    // whole obligation falls to the reserve.
    let sell_raw = if conservative == 0 {
        0
    } else {
        let wanted = (obligations as u128)
            .checked_mul(RAW_PER_TOKEN as u128)
            .ok_or(OthelloError::ValuationOverflow)?
            .div_ceil(conservative);
        wanted.min(input.stock_raw as u128) as u64
    };

    // recovered = floor(sell_raw x conservative / 1e8). May exceed O by less
    // than one raw unit's value; that excess stays in the vault as dust.
    let recovered = u64::try_from(
        (sell_raw as u128)
            .checked_mul(conservative)
            .ok_or(OthelloError::ValuationOverflow)?
            / RAW_PER_TOKEN as u128,
    )
    .map_err(|_| OthelloError::ValuationOverflow)?;

    let funded_from_stock = obligations.min(recovered);
    let shortfall = obligations - funded_from_stock;
    let loss = shortfall.min(input.reserve_available);
    let deficit = shortfall - loss;
    let forfeited = shortfall.min(
        input
            .guarantee
            .checked_add(input.top_ups)
            .ok_or(OthelloError::ValuationOverflow)?,
    );

    Ok(Waterfall {
        obligations,
        sell_raw,
        recovered,
        funded_from_stock,
        shortfall,
        loss,
        deficit,
        forfeited,
    })
}

pub fn handle_declare_default<'info>(
    ctx: Context<'info, DeclareDefault<'info>>,
    turn: u8,
) -> Result<()> {
    let circle = &ctx.accounts.circle;
    let now = Clock::get()?.unix_timestamp;

    // SPEC §5, in the row's order.
    require!(
        circle.status == CircleStatus::Active,
        OthelloError::CircleNotActive
    );
    require!(turn < circle.n, OthelloError::InvalidParams);

    // I7. Strictly after deadline + grace. The deadline is set when the round
    // opens (activate, or the previous release_pot), so a seat is never
    // defaultable sooner than round_secs + grace after its round opened.
    let defaultable_after = circle
        .round_deadline
        .checked_add(circle.grace_secs)
        .ok_or(OthelloError::ValuationOverflow)?;
    require!(now > defaultable_after, OthelloError::GraceNotElapsed);

    let bit = 1u8 << turn;
    require!(circle.paid_bitmap & bit == 0, OthelloError::SeatAlreadyPaid);
    // KNOWN-LIMITS L3. Before their payout a member owes the circle nothing
    // that collateral stands behind, so there is nothing for a waterfall to
    // settle. They can still pay late.
    require!(
        circle.received_bitmap & bit != 0,
        OthelloError::PrePayoutDefaultUnsupported
    );
    require!(
        circle.defaulted_bitmap & bit == 0,
        OthelloError::AlreadyDefaulted
    );

    // Wrapper price fresh. Only freshness and a non-zero wrapper price: the
    // share price and the multiplier stamp do not enter the sale (I13).
    let feed = &ctx.accounts.price_feed;
    let age = now
        .checked_sub(feed.updated_at)
        .ok_or(OthelloError::PriceStale)?;
    require!(
        age <= circle.max_price_age && feed.wrapper_price > 0,
        OthelloError::PriceStale
    );

    let circle_key = circle.key();
    let mut members = load_members(circle, circle_key, ctx.remaining_accounts)?;
    let d = turn as usize;

    let w = waterfall(&WaterfallInput {
        contribution: circle.contribution,
        n: circle.n,
        rounds_paid: members[d].rounds_paid,
        stock_raw: members[d].stock_raw,
        wrapper_price: feed.wrapper_price,
        discount_bps: ctx.accounts.pool.discount_bps,
        reserve_available: circle.reserve_total.saturating_sub(circle.reserve_losses),
        guarantee: members[d].guarantee,
        top_ups: members[d].top_ups,
    })?;

    require!(
        ctx.accounts.pool_usdc_vault.amount >= w.recovered,
        OthelloError::PoolInsufficient
    );

    // The sale. The circle signs for its stock vault, the pool for its USDC.
    if w.sell_raw > 0 {
        let creator = circle.creator;
        let circle_id = circle.circle_id.to_le_bytes();
        let seeds: &[&[u8]] = &[Circle::SEED, creator.as_ref(), &circle_id, &[circle.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.stock_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.circle_stock_vault.to_account_info(),
                    mint: ctx.accounts.stock_mint.to_account_info(),
                    to: ctx.accounts.pool_stock_vault.to_account_info(),
                    authority: ctx.accounts.circle.to_account_info(),
                },
                &[seeds],
            ),
            w.sell_raw,
            ctx.accounts.stock_mint.decimals,
        )?;
    }
    if w.recovered > 0 {
        let usdc_mint = ctx.accounts.usdc_mint.key();
        let stock_mint = ctx.accounts.stock_mint.key();
        let pool_seeds: &[&[u8]] = &[
            LiquidationPool::SEED,
            usdc_mint.as_ref(),
            stock_mint.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.usdc_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pool_usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.circle_usdc_vault.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            w.recovered,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    // The books, SPEC §6 line by line.
    let circle = &mut ctx.accounts.circle;
    circle.reserve_losses = circle
        .reserve_losses
        .checked_add(w.loss)
        .ok_or(OthelloError::ValuationOverflow)?;
    circle.escrow = circle
        .escrow
        .checked_add(w.funded_from_stock)
        .and_then(|e| e.checked_add(w.loss))
        .ok_or(OthelloError::ValuationOverflow)?;
    circle.escrow_deficit = circle
        .escrow_deficit
        .checked_add(w.deficit)
        .ok_or(OthelloError::ValuationOverflow)?;

    let defaulter = &mut members[d];
    let previously_forfeited = defaulter.forfeited;
    defaulter.forfeited = w.forfeited;
    defaulter.allocated = 0;
    defaulter.stock_raw = defaulter
        .stock_raw
        .checked_sub(w.sell_raw)
        .ok_or(OthelloError::ValuationOverflow)?;
    circle.forfeited_total = circle
        .forfeited_total
        .checked_sub(previously_forfeited)
        .and_then(|t| t.checked_add(w.forfeited))
        .ok_or(OthelloError::ValuationOverflow)?;
    circle.defaulted_bitmap |= bit;

    // Recompute. SPEC §5: exactly as update_coverage when the share price is
    // fresh and not repricing; freshness was checked above, so the question is
    // whether the feed is priced for the multiplier in force. A mint whose
    // multiplier cannot be read counts as repricing: the sale did not need it,
    // and the recompute cannot use it.
    let priced_for_now = {
        let mint_info = ctx.accounts.stock_mint.to_account_info();
        let mint_data = mint_info.try_borrow_data()?;
        let now_fixed = scaled_ui_config(&mint_data)
            .and_then(|config| decode_multiplier_fixed(effective_multiplier_bits(&config, now)));
        matches!(now_fixed, Ok(m) if m == ctx.accounts.price_feed.priced_for_multiplier)
            && ctx.accounts.price_feed.share_price > 0
    };

    let recomputed = if priced_for_now {
        let mint_info = ctx.accounts.stock_mint.to_account_info();
        let mint_data = mint_info.try_borrow_data()?;
        recompute_coverage(
            circle,
            &mut members,
            &ctx.accounts.price_feed,
            &mint_data,
            now,
        )?;
        true
    } else {
        // The capped branch (r4): no H. The defaulter's allocation is already
        // zero; the survivors keep what they had, capped in turn order to what
        // the reserve still holds, so I2 stays true. Paused moves by what the
        // reserve could not absorb, approximately, until the next
        // update_coverage; last_coverage_at is not stamped, because nothing
        // was valued.
        let mut remaining = circle.reserve_total.saturating_sub(circle.reserve_losses);
        let mut total: u64 = 0;
        for member in members.iter_mut() {
            let take = member.allocated.min(remaining);
            member.allocated = take;
            remaining -= take;
            total = total
                .checked_add(take)
                .ok_or(OthelloError::ValuationOverflow)?;
        }
        circle.reserve_allocated = total;
        circle.next_gate_short_by = circle.next_gate_short_by.saturating_add(w.deficit);
        false
    };

    for member in members.iter() {
        member.exit(&crate::ID)?;
    }

    emit!(DefaultDeclared {
        circle: circle_key,
        turn,
        round: circle.round,
        obligations: w.obligations,
        sell_raw: w.sell_raw,
        recovered: w.recovered,
        funded_from_stock: w.funded_from_stock,
        shortfall: w.shortfall,
        loss: w.loss,
        deficit: w.deficit,
        forfeited: w.forfeited,
        recomputed,
        escrow: circle.escrow,
        escrow_deficit: circle.escrow_deficit,
        next_gate_short_by: circle.next_gate_short_by,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    /// SPEC.md:135's demo circle: n = 5, c = 50, 1.1 token locked, wrapper 150,
    /// pool discount 2000, so the conservative price is 120 a token.
    fn demo(rounds_paid: u8, reserve_available: u64) -> WaterfallInput {
        WaterfallInput {
            contribution: 50 * USDC,
            n: 5,
            rounds_paid,
            stock_raw: 110_000_000,
            wrapper_price: 150 * USDC,
            discount_bps: 2000,
            reserve_available,
            guarantee: 35 * USDC,
            top_ups: 0,
        }
    }

    #[test]
    fn the_first_recipient_defaulting_at_round_one_sells_everything_and_the_reserve_takes_the_rest()
    {
        // Paid round 0, received, missed round 1: O = 50 x 4 = 200. The stock
        // is worth 1.1 x 120 = 132, so all of it goes and 68 is short. The
        // reserve (175) absorbs all 68, and the forfeit is capped at the
        // defaulter's own 35.
        let w = waterfall(&demo(1, 175 * USDC)).unwrap();
        assert_eq!(w.obligations, 200 * USDC);
        assert_eq!(w.sell_raw, 110_000_000);
        assert_eq!(w.recovered, 132 * USDC);
        assert_eq!(w.funded_from_stock, 132 * USDC);
        assert_eq!(w.shortfall, 68 * USDC);
        assert_eq!(w.loss, 68 * USDC);
        assert_eq!(w.deficit, 0);
        assert_eq!(w.forfeited, 35 * USDC);
    }

    #[test]
    fn a_late_default_sells_only_what_is_owed_and_leaves_the_rest_of_the_stock() {
        // Paid three rounds, missed the fourth: O = 50 x 2 = 100. At 120 a
        // token that is ceil(100e6 x 1e8 / 120e6) = 83,333,334 raw, and the
        // other 26,666,666 raw stay the defaulter's.
        let w = waterfall(&demo(3, 175 * USDC)).unwrap();
        assert_eq!(w.obligations, 100 * USDC);
        assert_eq!(w.sell_raw, 83_333_334);
        assert_eq!(w.recovered, 100 * USDC);
        assert_eq!(w.shortfall, 0);
        assert_eq!(w.loss, 0);
        assert_eq!(w.forfeited, 0);
    }

    #[test]
    fn seized_value_never_exceeds_the_obligation_by_a_raw_unit() {
        // I9, over a spread of prices and obligations: what was sold, valued
        // at the conservative price, is at most O plus one raw unit's worth.
        for wrapper in [1u64, 7, 149_999_999, 150 * USDC, 1_234_567_891] {
            for rounds_paid in 0..5u8 {
                let input = WaterfallInput {
                    wrapper_price: wrapper,
                    stock_raw: u64::MAX / 4,
                    ..demo(rounds_paid, 175 * USDC)
                };
                let w = waterfall(&input).unwrap();
                let conservative = wrapper as u128 * 8000 / 10_000;
                let seized = w.sell_raw as u128 * conservative;
                // sell_raw = ceil(O x 1e8 / c), so sell_raw x c < O x 1e8 + c:
                // strictly less than O plus the value of one raw unit.
                let bound = w.obligations as u128 * RAW_PER_TOKEN as u128 + conservative;
                assert!(
                    seized < bound || w.sell_raw == 0,
                    "wrapper {wrapper}, rounds_paid {rounds_paid}"
                );
                assert!(w.recovered >= w.obligations || conservative == 0);
            }
        }
    }

    #[test]
    fn what_the_reserve_cannot_absorb_becomes_an_escrow_deficit() {
        // Same default as the first test, against a reserve that has only 50
        // left: 50 is a loss and 18 is a deficit, which a top-up must cure.
        let w = waterfall(&demo(1, 50 * USDC)).unwrap();
        assert_eq!(w.shortfall, 68 * USDC);
        assert_eq!(w.loss, 50 * USDC);
        assert_eq!(w.deficit, 18 * USDC);
        // r3: the forfeit is measured against the shortfall, not the loss.
        assert_eq!(w.forfeited, 35 * USDC);
    }

    #[test]
    fn the_forfeit_is_measured_against_the_shortfall_even_when_the_reserve_absorbs_less() {
        // r3's rule, at the only place it differs from measuring the loss: the
        // reserve has 20 left, less than the defaulter's own 35. The loss is
        // 20, the shortfall 68, and the forfeit is the full 35, because what
        // the defaulter failed to cover is 68 whoever ends up carrying it.
        let w = waterfall(&demo(1, 20 * USDC)).unwrap();
        assert_eq!(w.loss, 20 * USDC);
        assert_eq!(w.deficit, 48 * USDC);
        assert_eq!(w.forfeited, 35 * USDC);
    }

    #[test]
    fn a_price_too_small_to_buy_anything_sells_nothing() {
        let w = waterfall(&WaterfallInput {
            wrapper_price: 1,
            ..demo(1, 175 * USDC)
        })
        .unwrap();
        assert_eq!(w.sell_raw, 0);
        assert_eq!(w.recovered, 0);
        assert_eq!(w.shortfall, 200 * USDC);
    }
}
