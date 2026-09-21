# Glossary

One term, one meaning, in code, UI, tests and docs.

| Term | Means | Never say |
|
## Code terms
| Term | Meaning |
|---|---|
| raw | token base units (stock: 8 dp) |
| mult_fixed | multiplier × 1e9, exact floor of the PodF64 value |
| FUND / EXEC | fundamental (raw × mult × share price) / executable (raw × non-scaled wrapper price) value |
| H | stock cover = floor(min(FUND, EXEC) × (1 − haircut)) |
| O | owed = contribution × remaining rounds (received members only) |
| need | reserve required for a member = max(0, ceil(O × coverage) − H) |
| G / allocated | reserve allocated to a member |
| avail / remaining | reserve_total − reserve_losses |
| free | remaining − reserve_allocated |
| escrow / escrow_deficit | USDC prefunding a defaulter's remaining contributions / the part not yet funded |
| forfeited | a defaulter's own deposit consumed by their shortfall |
| next_gate_short_by | on-chain Paused signal (> 0 = Paused), as of the last refresh |
| stamp | which multiplier a price was set for (Current / Scheduled) |
