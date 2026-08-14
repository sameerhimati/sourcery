# Preregistration, third version — the plan of record for run 2

**Status: this is the plan.** It replaces [`preregistration-v2.md`](preregistration-v2.md)
and [`run-2-build.md`](run-2-build.md), both of which describe designs that were
abandoned before anything ran. It is written before the run, because a method
written after seeing the data is indistinguishable from a method picked to
flatter it.

The argument for every choice here is [`eval-harness.md`](eval-harness.md), the
method in one page. This document is the commitment, not the argument: what
will be measured, how, and what would prove the design wrong.
The code implementing it is `core/pooled.ts`, `core/pool.ts`,
`core/relevanceJudge.ts`, and `core/anchors.ts`, run through
`sourcery pooled` and `sourcery calibrate`.

## What is being measured

Which pages each web-search provider returns for a fixed set of questions —
nothing downstream of that. No answer is written and no answer is graded in
this run's headline. (Answer quality remains measurable separately with the
run-1 machinery; run 1 already showed the two don't track each other, and that
gap is its own finding, not a component of this one.)

## The procedure

1. **Calibrate the judges first.** Every candidate judge model is scored
   against the anchor set — question-and-page pairs whose ratings a human has
   settled — including the probes: well-formatted pages stuffed with the
   question's keywords that answer nothing, whose correct rating is 0 by
   construction. **A judge that rates any probe above 0 is out.** If fewer
   than five judges survive, the run waits rather than shrinking the panel
   silently.
2. **Fetch.** Every question goes to every provider once, through the same
   code path with the same settings. One fetch per pair, not five: run 1
   measured what re-fetching moves (`SEED_NOISE` in `core/controls.ts`), so
   run 2 spends that budget on breadth instead.
3. **Pool.** Everything any provider returned is collapsed into unique
   question-and-page pairs (URL-normalized conservatively — fragments,
   tracking parameters, host case — never anything that could merge two
   genuinely different pages).
4. **Judge.** Each unique pair is rated once by each of five judge models
   from five different labs, on four named rungs: 0 not relevant, 1 marginal,
   2 relevant, 3 highly relevant. The judge sees the question and the page —
   never a provider name. Pooling detaches pages from providers before
   judging, so blinding is structural rather than promised. A verdict that
   isn't a valid rung is counted and excluded, never scored as 0.
5. **Score.** A provider's result on a question is computed from its returned
   links against the pooled verdicts, all links weighted equally.

## The numbers that will be reported

Defined here, in advance, in words:

- **Mean rung** (the headline): the average 0–3 rating of the links a
  provider returned, averaged per question first, with a 95% confidence
  interval across questions.
- **Precision**: the share of a provider's returned links rated relevant
  (rung 2 or higher) — the binary collapse of the scale, reported beside the
  graded number as a robustness check.
- **Recall**: of all the pooled pages rated relevant for a question, the
  share this provider returned. Pooling is what makes a recall denominator
  exist at all.
- **Latency**: percentiles of the retrieval call alone (`fetch_ms`), never of
  anything that includes our own LLM calls.
- **Judge agreement, three numbers together, never one alone**: raw exact
  agreement, chance-corrected agreement (Cohen's kappa), and how each judge
  distributed its ratings. Each alone can be made to say almost anything; the
  1977 convention bands ("fair", "substantial") are not quoted as pass marks.
- **Where the variation comes from**: shares of total score variation
  attributable to provider, question, judge, and the provider-by-question
  interaction.

## Failures

- A failure the provider is answerable for scores a **miss** — zero on all
  metrics for that question. It didn't return the pages. Dropping the row
  would flatter exactly the providers that fail most.
- A failure that was ours — this machine's network, our billing — is
  **excluded and published as a count**. Attributing our outage to a vendor
  is the mistake run 1 made twice and this design exists to prevent.
- `error_stage` decides which is which; an unattributable failure is charged
  to no one. **No failure count is published without checking `error_stage`.**

## The decision this run is not allowed to make in advance

Whether the output is a **ranking or a map**. If the variance decomposition
shows the provider effect is small while the provider-by-question interaction
is large, then "which provider is best" has no answer, the honest output is a
map — this provider for that kind of question — and no overall winner is
declared. That rule is written here precisely so it cannot be chosen after
seeing which story the data tells.

## What would prove this design wrong

- A probe page scoring above 0 with any panel judge → the judge is measuring
  keyword density; results from it are not published.
- Judge agreement collapsing on this question set → the questions are too
  ambiguous (the condition Voorhees-style stability depends on); the fix is
  rewriting questions, not swapping judges until the numbers behave.
- The decomposition showing the question sample is too small for a stable
  answer → collect more questions before publishing, or publish with that
  stated limit.

## Known limits, stated up front

- Whether language models should make relevance judgments at all is an open
  argument in the retrieval community. This run happens inside that argument.
  Every raw judgment is published as data so anyone can recompute or contest
  any number.
- Pooling has a blind spot: a great page no provider returned is invisible.
  At this scale every pooled pair is judged, so there is no unjudged tail —
  but the moment a ninth provider is added and old judgments are reused, that
  stops being true and the analysis has to adopt the machinery built for it.
- A pooled pair is judged on one canonical text (the longest extraction among
  the providers that returned it, recorded as `content_from`). Extraction
  quality therefore no longer leaks into the relevance verdict; it stays
  measurable per provider from the fetch rows.

## What has to exist before the run spends money

| piece | owner | state |
|---|---|---|
| The question set | Sameer | written — 96 questions in `datasets/run2-questions.json`, half of each type sharp, half open |
| The anchor set + probes (real, not the shipped examples) | Sameer | examples only |
| Keys: Brave, Serper, Perplexity Search, Parallel | Sameer | not created |
| Four new adapters | code | written, never run against a live key |
| Five-judge panel, five labs, none sharing a family with each other | both | candidates TBD once keys exist |
| Calibration pass with probes clean | run | gated on the above |

Providers measured: the eight from [`provider-admission.md`](provider-admission.md),
plus anyone who asks publicly.
