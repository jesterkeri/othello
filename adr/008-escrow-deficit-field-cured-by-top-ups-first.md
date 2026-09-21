# ADR-008: Escrow deficit field, cured by top-ups first

Status: accepted 2026-09-21 · two-way door

## Context
A default whose shortfall exceeds the reserve left the circle permanently stuck (review r1 CRITICAL).

## Decision
Record escrow_deficit; top_up_reserve fills it before growing the reserve; the fill is not returned.

## Rejected
dissolve instruction; reserve-to-escrow sweep

## Consequences
I14.
