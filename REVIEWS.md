# Reviews

One brief and one review per gate, both committed.

```
reviews/gate-1-brief.md      written by the builder, carries no justifications
reviews/gate-1-review.md     written by Codex, ends in the verdict line
```

Rules:
- The builder writes the brief and stops. It does not review its own diff.
- The brief includes KNOWN-LIMITS.md verbatim, marked do-not-re-report.
- The brief states the rules. It never argues for them.
- A fix after a review is the newest code and therefore the most suspect. Re-review.
- No gate closes on `VERDICT: changes required`.
