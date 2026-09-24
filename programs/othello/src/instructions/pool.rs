//! `init_pool` and `seed_pool` (T14). The liquidation pool is the only buyer of
//! seized stock (ADR-004): a default sells the defaulter's stock to it at the
//! conservative price, wrapper x (1 - discount), and it pays in USDC.
//!
//! On the demo it is seeded by the admin. Nothing here moves a member's tokens:
//! `seed_pool` moves the signer's own USDC into the pool (I8).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::allowlist;
use crate::errors::OthelloError;
use crate::events::{PoolInitialized, PoolSeeded};
use crate::state::LiquidationPool;
use crate::valuation::BPS_DENOMINATOR;

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The admin check, identical to `init_price_feed`'s: `authority` must be the
    /// program's upgrade authority. See the note on `InitPriceFeed`.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ OthelloError::Unauthorized)]
    pub program: Program<'info, crate::program::Othello>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ OthelloError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    /// Plain SPL Token only, never Token-2022 (T09 adversary, OPEN-QUESTIONS).
    /// Every circle bound to this pool takes its USDC mint from the pool's seeds,
    /// so this is the one place that decides what "USDC" is. A Token-2022 mint
    /// could carry TransferFeeConfig, and then `join_and_lock` would credit the
    /// reserve with a guarantee the vault received less of, which breaks I3.
    /// SPL Token has no extensions at all, so the whole class is closed rather
    /// than one extension at a time. SPEC §4 already has the USDC vault as SPL.
    #[account(
        mint::token_program = usdc_token_program,
        constraint = usdc_token_program.key() == anchor_spl::token::ID @ OthelloError::InvalidParams,
    )]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mint::token_program = stock_token_program)]
    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + LiquidationPool::INIT_SPACE,
        seeds = [LiquidationPool::SEED, usdc_mint.key().as_ref(), stock_mint.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, LiquidationPool>>,

    /// `init_if_needed`, not `init`: an associated token account can be created
    /// by anyone for any owner, so with `init` a stranger could create this one
    /// first and make `init_pool` fail for good. The address constraints below
    /// still pin its mint, owner and token program.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool,
        associated_token::token_program = usdc_token_program,
    )]
    pub pool_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Same reasoning. This is where seized stock lands.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = stock_mint,
        associated_token::authority = pool,
        associated_token::token_program = stock_token_program,
    )]
    pub pool_stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_pool(ctx: Context<InitPool>, discount_bps: u16) -> Result<()> {
    require!(
        allowlist::is_allowed(&ctx.accounts.stock_mint.key()),
        OthelloError::MintNotAllowed
    );
    // SPEC §5: discount_bps < 10000. A discount of 100% would be a pool that
    // pays nothing for stock, so every default would fund zero from collateral.
    require!(
        (discount_bps as u64) < BPS_DENOMINATOR,
        OthelloError::InvalidParams
    );

    let pool = &mut ctx.accounts.pool;
    pool.authority = ctx.accounts.authority.key();
    pool.bump = ctx.bumps.pool;
    pool.discount_bps = discount_bps;

    emit!(PoolInitialized {
        pool: pool.key(),
        authority: pool.authority,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        stock_mint: ctx.accounts.stock_mint.key(),
        discount_bps,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SeedPool<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [LiquidationPool::SEED, usdc_mint.key().as_ref(), stock_mint.key().as_ref()],
        bump = pool.bump,
        has_one = authority @ OthelloError::Unauthorized,
    )]
    pub pool: Box<Account<'info, LiquidationPool>>,

    #[account(mint::token_program = usdc_token_program)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: only a seed. The pool PDA above cannot be derived from the wrong
    /// stock mint, so the seeds are the whole check.
    pub stock_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = authority,
        token::token_program = usdc_token_program,
    )]
    pub authority_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool,
        associated_token::token_program = usdc_token_program,
    )]
    pub pool_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub usdc_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_seed_pool(ctx: Context<SeedPool>, amount: u64) -> Result<()> {
    require!(amount > 0, OthelloError::InvalidParams);
    require!(
        ctx.accounts.authority_usdc.amount >= amount,
        OthelloError::InsufficientBalance
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.usdc_token_program.key(),
            TransferChecked {
                from: ctx.accounts.authority_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.pool_usdc_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    ctx.accounts.pool_usdc_vault.reload()?;

    emit!(PoolSeeded {
        pool: ctx.accounts.pool.key(),
        amount,
        pool_usdc: ctx.accounts.pool_usdc_vault.amount,
    });

    Ok(())
}
