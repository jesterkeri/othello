# ADR-001: Exact PodF64 bit decode

Status: accepted 2026-09-21 · two-way door

## Context
The mint stores the multiplier as IEEE-754 f64. Float x SCALE rounds up in real cases (1.0000003 -> 1000000300) and overvalues collateral.

## Decision
Decode sign/exponent/mantissa to an exact rational, floor at 1e9.

## Rejected
float multiply; string parse of jsonParsed

## Consequences
Unit vectors in G1. One-way door for the valuation adapter.
