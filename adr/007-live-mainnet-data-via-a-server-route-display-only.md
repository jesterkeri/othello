# ADR-007: Live mainnet data via a server route, display only

Status: accepted 2026-09-21 · two-way door

## Context
Yahoo needs a browser UA and fails CORS; solvency must never read live data.

## Decision
Next.js route /api/live, 60 s cache.

## Rejected
browser fetch

## Consequences
Stock place has a degraded state.
