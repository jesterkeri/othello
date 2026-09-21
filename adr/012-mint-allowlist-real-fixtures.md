# ADR-012: Collateral by mint address; tests on real mint bytes

Status: accepted 2026-09-21 · two-way door

## Context
Joshua ruled out invented stock data. Symbols are spoofable (five tokens named NFLXx on Jupiter). Real xStock mints exist only on mainnet.

## Decision
A hardcoded allowlist of xStock mint addresses; create_circle refuses others (`mint_not_allowed`). Gate 1-3 tests load real mainnet mint account bytes as fixtures at their real addresses. The demo split is NFLXx's real 10-for-1 split.

## Rejected
A self-created mock mint with a staged split.

## Consequences
Deployment network still open (OPEN-QUESTIONS). On devnet the real addresses cannot exist, so a devnet deploy would need a mirror mint and a separate allowlist entry, labelled as such.
