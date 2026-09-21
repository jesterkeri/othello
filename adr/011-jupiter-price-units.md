# ADR-011: Jupiter price units

Status: accepted 2026-09-21 · two-way door

## Context
Jupiter's token API usdPrice is per UI (scaled) unit; its swap quote is per raw unit. Verified 2026-09-21 on NFLXx (multiplier 10): usdPrice 71.59, 0.01 raw quotes 7.07 USDC.

## Decision
wrapper_price (non-scaled) = swap quote per raw token, or usdPrice x effective multiplier. usdPrice is never used directly as wrapper_price.

## Rejected
usdPrice as wrapper price (10x undervalue on NFLXx).

## Consequences
ops/set-prices.ts and /api/live read the multiplier before converting. Test with the NFLXx fixture.
