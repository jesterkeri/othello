# ADR-005: Oracle epoch match blocks payouts during repricing

Status: accepted 2026-09-21 · two-way door

## Context
Price and multiplier can disagree around a split, producing 10x false values.

## Decision
Fundamental value only when feed.priced_for_multiplier == effective multiplier; else refuse payouts/coverage/join; missed-payment default still allowed.

## Rejected
time-window pause (guessing the window)

## Consequences
I13.
