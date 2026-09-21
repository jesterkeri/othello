# ADR-009: Gate refusal codes by cause (option B)

Status: accepted 2026-09-21 · two-way door

## Context
Two codes computed from the same inequality made one unreachable (review r1).

## Decision
coverage_too_low iff recipient's H < min and others fit; else reserve_overcommitted; payloads carry needed/remaining/short_by/recipient_gap/others_need.

## Rejected
single reserve_short code

## Consequences
I1 tests one case per code.
