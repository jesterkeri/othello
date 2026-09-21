# ADR-006: Escrow pays defaulted seats inside release_pot

Status: accepted 2026-09-21 · two-way door

## Context
A separate contribute-for-defaulter instruction adds a tx per round.

## Decision
release_pot checks escrow >= k x c and debits it.

## Rejected
contribute_for_defaulted

## Consequences
release_pot takes all Member accounts.
