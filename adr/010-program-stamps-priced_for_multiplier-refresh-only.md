# ADR-010: Program stamps priced_for_multiplier; refresh only touches the timestamp

Status: accepted 2026-09-21 · two-way door

## Context
A price-refresh script re-stamping Current mid-split reproduced the double-count (review r2 CRITICAL).

## Decision
set_prices(stamp, expected_multiplier_fixed) verified against the mint; touch_prices changes updated_at only.

## Rejected
admin-supplied multiplier value

## Consequences
I17.
