# ADR-002: Recompute allocations from scratch

Status: accepted 2026-09-21 · two-way door

## Context
Incremental reserve bookkeeping drifts across defaults and price moves.

## Decision
Every mutating instruction recomputes need and allocation from current state.

## Rejected
incremental counters

## Consequences
Costs CU (n <= 8). I2 property test.
