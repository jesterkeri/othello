# ADR-004: Liquidation pool inside the Othello program

Status: accepted 2026-09-21 · two-way door

## Context
A separate mock AMM costs a second deploy (~2 SOL) on a 2.5 SOL budget.

## Decision
Pool is PDAs of the same program; default seizes stock and pays USDC in one ix.

## Rejected
separate mock AMM program

## Consequences
Swapping for a real DEX route later is an adapter change.
