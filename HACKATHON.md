# Stocklana: the rules, as published

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
- [ ] NOT STATED items above confirmed against the submission form itself, which
      may ask for more than the rules page publishes
