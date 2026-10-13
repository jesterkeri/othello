# Hackathons

Othello was built from 2026-09-21 (first commit) and entered at three hackathons. Each entry is disclosed in the
others.

| Hackathon | Entry | Status |
|---|---|---|
| [Colosseum Crypto World's Fair](https://colosseum.com/worldsfair) | Othello on Solana devnet and Robinhood Chain testnet, one website | submitted by 2026-10-12 23:59 PT |
| [Arbitrum Open House](https://openhouse.arbitrum.io/) (online buildathon) | the Robinhood Chain build: `OthelloFactory` / `OthelloCircle`, test USDG | submitted (deadline 2026-10-04) |
| [Stocklana](https://hackathons.solana.com/hackathons/stocklana) (Solana) | the first Solana devnet build of the Anchor program | submitted 2026-09-25 |

Colosseum's rules: the official rules
([PDF](https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf)) and the
[FAQ](https://www.colosseum.com/hackathon#faqs). Contest period 2026-09-14 06:00 PT to 2026-10-12 23:59 PT, so all of
Othello was built inside it. Work since the earlier entries: the Robinhood Chain build, one chain-neutral website over
both chains (circles list, circle page, portfolio, how it works), the live devnet circle page and the Solana join,
leave, start and cancel actions.

Open-source and third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Othello's own code: [MIT](LICENSE).

---

## Stocklana: the rules, as published (2026-09-22)

Source: https://hackathons.solana.com/hackathons/stocklana
Fetched 2026-09-22 by the build session. Quotes are the site's words. Anything
marked NOT STATED is absent from that page, not inferred.

## The one criterion

> "One question: could this be a real app that people will actually use?"

Judges assess: a real user and problem, a working end-to-end demo, Solana
relevance, execution quality. **No scoring rubric or weighting is published.**

There is **no requirement to demonstrate correctness in the app**, no code
audit, and no proof artifact. That question was raised on 2026-09-22 and this
answers it: the user-facing product is what is scored.

## Submission

> "at least one link: GitHub, live demo, or video"

That is the whole requirement. One link clears the bar, and this repo is a
GitHub link, so the submission itself cannot be lost. What is SCORED is whether
it looks like an app people would use, which a repo link alone does not show.

NOT STATED: demo video length, whether the repo must be public, whether a live
deployment is mandatory, which network is required.

## Requirements, as distinct from the criteria

Checked separately on 2026-09-22 because criteria are what you are scored on and
requirements are what disqualifies you.

| requirement | published wording | status |
|---|---|---|
| **Register** | "Register, then **Submit Project** before the deadline" | **DONE 2026-09-22**, @jester_keri, confirmed by the Registered badge on the hackathon page |
| Team | "Invite teammates from the submit form" | n/a, solo |
| One submission per team | "Individuals and teams, one submission per team, original work" | fine |
| Pre-existing code | "Open-source components are fine if you say so" | allowed, must be disclosed |
| Links | "Include at least one link: GitHub, live demo, or video" | GitHub satisfies it |

**NOT STATED anywhere on the site**, and therefore unknown rather than absent:
the start date and whether work must be done inside the window; which track or
bounty you select at submission; the submission form's actual fields; whether a
demo video is required and how long; whether the repo must be public or
licensed; whether a live URL is required; which network is required; KYC,
wallet, email, GitHub-account, residency, age or jurisdiction restrictions;
prohibited countries; any Discord or social requirement.

There is **no site-wide terms, rules, eligibility, legal or FAQ page** linked
from hackathons.solana.com. The footer carries only BUILD, SPONSOR and ABOUT.

### What this means

The rules page is the shape; **the submission form is the authoritative source
for requirements**, and it sits behind registration where it cannot be read
from outside. Everything in the NOT STATED list above is knowable only by
opening that form.

**Register and open the submission form now, not on Friday.** A required field
discovered at 20:00 Lagos on the deadline is the failure mode that has cost a
finish before. Registering also costs nothing and removes lock-out risk, and
`design/FRAME.md:32` already records that edits are allowed after submitting,
so a stub submission can go in early and be improved.

## What the page shows once registered (2026-09-22)

| | |
|---|---|
| prize pool, total | **$126,000** (the $100,000 main track plus the five bounties) |
| registered | 818 |
| **submissions already in** | **169** |
| bounty tracks | 5 |
| deadline, as the site renders it in Lagos time | **Sep 25, 2026, 9:00 PM**, "in 3 days" |
| build window | "One week to build something innovative with stocks on Solana", so it opened around 18 September |

169 submissions against 818 registered says most entrants have not submitted
yet and will arrive late. That is an argument for a stub submission early
rather than a reason to relax: the form is the only place the real requirements
are written, and it is worth opening before the queue.

## Deadline

> "Friday 25 September, 4:00pm ET"

= Fri 25 Sep 21:00 Lagos. Matches `design/FRAME.md:32`.

## Eligibility

> "Individuals and teams, one submission per team, original work. Open-source
> components are fine if you say so."

## Tracks and bounties

| bounty | prize | what it requires | Othello today |
|---|---|---|---|
| Main track | $100,000 | tokenised stock applications | **eligible, this is the target** |
| PreStocks | $10,000 (5k/3k/2k) | use PreStocks; **integrating any non-PreStocks pre-IPO token makes you INELIGIBLE** | not eligible, and not pursued |
| Tessera | $6,000 | a product with OpenAI/Kalshi T-Tokens | not eligible |
| Clawpump | $5,000 (3k/1.5k/500) | launch a token with a stock-paired pool on Clawpump/Meteora | not eligible |
| Meteora | $5,000 | build on Dynamic Bonding Curve | not eligible |
| Pyth | 3 months Pyth Pro | "use Pyth market data in a Solana application", judged on how CENTRAL Pyth is to the product | not eligible as built |

Othello uses xStocks by Backed, not PreStocks, so the PreStocks
disqualification clause does not bite: it only removes eligibility for that
bounty, not for the main track.

## Checklist before T26

- [ ] one link in the submission form (GitHub satisfies it; a live demo or video scores it)
- [ ] the demo shows a real user solving a real problem end to end
- [ ] the reason it belongs on Solana is stated, not implied
- [ ] original work declared; open-source components named
- [ ] submitted before Fri 25 Sep 21:00 Lagos, with edits allowed after
- [x] **REGISTER** — done 2026-09-22, @jester_keri
- [ ] **open the Submit Project form and record every field it asks for, here**. This is
      the last unknown: the form is the authoritative source for requirements and cannot
      be read from outside
- [ ] NOT STATED items above confirmed against that form, which may ask for more
      than the rules page publishes
- [ ] a stub submission in early, since edits are allowed after (design/FRAME.md:32)
