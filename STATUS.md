# Status

| field | value |
|---|---|
| project | Othello: xStock-backed mutual credit circle (Stocklana hackathon) |
| stage | 6 build (Claude Code), gate 1 |
| tier | 1 (short doc per stage) |
| updated | 2026-09-21 |
| blocked on | nothing. Branch ruleset must make CI checks required (Joshua) |

## Stage log
<!-- one line per stage boundary: stage, state, date -->
- 0 route: written spec (SPEC v4, three Codex reviews) -> Stage 1 seeded from it + diff. 2026-09-21
- 1 frame + tier: done, Tier 1, design/FRAME.md. 2026-09-21
- 2 flow-design: done, design/FLOWS.md (decisions D1-D10). 2026-09-21
- parallel: Joshua runs the Anchor spike (gate 1) in Claude Code now, from SPEC v4 build order steps 1-8. Design continues here. 2026-09-21
- 2.5 ux-design gate: passed after fixing 1 STOP (Join never named the reserve deposit). design/UX-REVIEW.md. 2026-09-21
- 3 system-design: done, design/SYSTEM.md (ADR-001..007, I1-I13, gates G1-G5). 2026-09-21
- 4 adversarial review: 4 rounds (fable). r1 C2 M10 m10, r2 C1 M6 m8, r3 C0 M3 m4, r4 C0 M0 m4 -> implementation-ready; r4 minors fixed. design/reviews/. 2026-09-21
- 5 harness installed + pack written (SPEC, INVARIANTS, ARCHITECTURE, GLOSSARY, adr/001-010, PIPELINE, TASKS T01-T26, KNOWN-LIMITS L1-L14, PREFLIGHT). 2026-09-21
- 6 build: handed to Claude Code at gate 1 (T01). 2026-09-21
