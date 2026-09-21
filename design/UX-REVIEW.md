# Othello: UX gate (stage 2.5)

Method: a subagent held only the screen copy and sample messages from FLOWS.md (no rationale, no conversation) and answered premise, walkthrough, jargon and warmth questions. Quotes are its words. All findings are **predicted** (model reader), not observed with a real person. Date 2026-09-21.

## Which failure

**Comprehension.** The premise passed: from the heading alone the reader said "a rotating savings group, like an ajo/susu/tanda, where the app enforces the rules instead of trust". The money mechanics under it did not land.

## Findings

```
[STOP] Join takes a reserve deposit it never mentions
Where: Join, before "Join and lock"
The person: "I can't tell where the reserve's money comes from... it worries me that I'm asked to fund it." Also: "I'd want to know how much stock gets locked before I press it."
Why: the join transaction moves two things (stock + guarantee USDC) and the copy names neither amount. Money leaving without being named breaks the premise of "nobody has to trust anybody".
Fix: Join lists exactly what you put in and what comes back: "You lock 0.42 AAPLx and put 30 USDC into the circle's shared reserve. Both come back when the circle ends, minus any share of a default."
Found by: walkthrough step 1, question 4
```

```
[STING] Top-up asks honest members to pay for someone else's shortfall
Where: Circle, payout refused / paused
The person: "I'd have to pay extra because Tunde's stock dropped... the honest people pay to fix it."
Why: the refusal offers the recipient's fix and the group's fix as equals, so it reads as a bill to everyone.
Fix: recipient's action first, group's second, and say a top-up is returned: "Tunde can lock more stock to release his pot. Or any member can add 56 USDC to the reserve, returned when the circle ends."
Found by: warmth
```

```
[STUMBLE] "Recheck" means nothing
Where: Circle, Split lab
The person: "What am I rechecking? Why would I?"
Fix: rename to "Update coverage" (muted: refresh_health). Helper: "Coverage uses prices from {age} ago."
Found by: walkthrough q3
```

```
[STUMBLE] "Anyone can pay out Tunde" reads as paying someone with your money
Where: Circle, round funded
The person: "Why would I press a button to pay someone else?"
Fix: CTA "Release pot to Tunde". Message: "Round 2 is fully funded. Anyone can release the pot to Tunde; it's already collected."
Found by: walkthrough q3
```

```
[STUMBLE] Two words for one thing: cover and collateral
Where: Position ("Add collateral") vs everywhere else ("cover")
Fix: surface word is "locked stock" for the asset and "stock cover" for its counted value. CTA "Lock more stock". "Collateral" only in muted true-term text.
Found by: jargon
```

```
[STUMBLE] "Lower of two prices" names neither
Where: Position helper
Fix: "Counted at the lower of its market price and its share price, minus a {haircut}% safety margin." (muted: min(executable, fundamental) x haircut)
Found by: jargon
```

```
[STUMBLE] "Keep the exposure" is jargon on the landing
Where: Landing helper
Fix: "Lock tokenized stock as a promise. You still own it. You get it back when the circle ends."
Found by: jargon
```

```
[STUMBLE] Defaulter "prepaid" is confusing
Where: Default message
The person: "Does she still get anything?"
Fix: "Kemi already received her pot in round 1 and stopped paying. Her stock was sold to cover what she still owed."
Found by: walkthrough, default
```

```
[STUMBLE] Split lab reads as a developer demo; "handkerchief test" unknown
Where: Split lab heading
Fix: heading "What a stock split does to your locked stock". "The handkerchief test" moves to a muted subtitle (the Othello reference is for the pitch, not the screen).
Found by: ten-second, jargon
```

```
[STUMBLE] "Most you could lose" alarms without saying how
Where: Join
Fix: "Most you could lose: 30 USDC, your reserve deposit, only if other members default and their stock doesn't cover it."
Found by: warmth
```

## Word budget

Net about zero. Added: the Join amounts line, the "returned when the circle ends" clause, how max loss happens. Removed: "Keep the exposure", "Recheck", "Anyone can pay out", "prepaid", the handkerchief heading, "the lower of two prices" (replaced, not appended).

## Acceptance test

Show the Join screen for 10 seconds, no clicking, then ask: **"What do you put in, what could you lose, and when do you get it back?"** Pass = the stranger names the stock amount, the reserve deposit, the max loss and "at the end". Run it on one real person before Friday.

## Gate

STOP fixed in FLOWS.md (copy and dialogs updated). Proceed to stage 3.
