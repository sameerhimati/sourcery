# The plan for run 2, published before it runs

**Status: DRAFT — not binding yet.** This becomes the commitment when the checklist
at the bottom is filled in and the repo is tagged `prereg-v2`. **Nothing runs
before that tag exists.** If you're reading this at an untagged commit, the plan
was still being written.

Drafted 2026-08-12. Harness: `sourcery-eval` 0.3.0, the `credibility` command.
Run 1 (`docs/findings.md`) stands as published; nothing here replaces it.

---

## 1. Disclosure

An engineer at **Exa** read run 1, disagreed with one of the implications, and
asked whether it would hold on harder questions. They also gave us **$100 in Exa
API credits**. Exa is one of the providers measured here.

Plainly, because it's a small thing that's easy to make sound big: $100 of API
credits is not funding and this is not a sponsored benchmark. The credits cover
Exa's own calls; every other provider is paid for out of pocket. Exa gets no early
look at results and no right to review, comment, or delay.

**The part that matters isn't the credits — it's that the question came from a
provider being measured.** A question proposed by one of the contestants may be
framed in a way that favours them, whether anyone meant it to or not. That risk
would exist even if no credits had changed hands.

The defence is this document. The questions, the scoring, and the result that
would prove the idea wrong are all fixed and published before anything runs. This
disclosure ships in the README and with the results, whatever the results say.

---

## 2. What isn't changing

Run 2 is a new set of questions and two new ways of scoring, on the same harness.
These stay exactly as they were:

- **The setup.** Same question, same answer model, same judge prompts, swap only
  the search provider.
- **The two judges** and both their prompts, byte-identical to `core/controls.ts`.
  We add more judges as a clearly-labelled extra, but the original two stay as the
  spine — otherwise run 1 and run 2 can't be compared.
- **Per-step error tagging.** A failure we can't place is recorded as `unknown`
  and charged to nobody.
- **No favourites.** Every provider is analysed the same way. This is an
  evaluation of web-search providers, not a piece about any one of them.
- **The frozen sets.** The built-in 48 (`core/eval-dataset.ts`) and the 24 real
  tasks (`datasets/real-tasks.json`) are not edited. Run 2 adds a third set.

---

## 3. The question we're testing

As the Exa engineer put it, as fairly as we can render it:

> Run 1's questions lean on freshness — "what is the latest X" — and that's a
> regime where providers look similar. On questions where relevance and source
> quality matter more than recency, and where the answer requires finding
> something specific or obscure, providers should separate more. **The gap widens
> as retrieval gets harder.**

That's a claim about a *trend*, not a comparison. You can't test it with one
bucket of hard questions — "on hard questions, X won" is a different and much less
interesting statement. Testing a trend needs difficulty to be a dial with at least
three settings.

**The idea being tested:** the gap between providers grows as questions get harder.

**The result we expect to be able to accept instead:** the gap is flat. Providers
separate by about the same amount whether the answer is sitting on the first
result or scattered across three obscure pages.

**The trap we have to rule out:** the gap *looks* like it grows because the
measurement gets noisier on hard questions, not because providers actually
separate. Section 8 deals with this directly, and section 6 is what makes dealing
with it possible.

---

## 4. What "harder" means

### Why not "more obscure"

Difficulty has to be something we can check about the world *before* any provider
runs. Otherwise the labels quietly bend to fit whatever the results show, and the
question stops being answerable. "This one feels obscure" is not checkable.
**Where the answer physically sits** is.

Each tier below names a different way retrieval can fail. Which tier a question
belongs to is decided while writing down its answer (section 5), and the reason is
recorded.

### The three tiers

**Tier 1 — the answer is the top result.**
It's stated on a single page, and that page is the first thing you'd get from the
obvious phrasing. Retrieval only has to return the obvious page. *Fails on:
coverage.*

**Tier 2 — the answer is buried on one page.**
It exists word-for-word on exactly one page, but not the obvious landing page —
it's in a changelog, a sub-page, a table, a PDF, an appendix. **The topic's main
page doesn't contain it.** Retrieval has to rank past the obvious result, or go
deep enough to pull the real content. *Fails on: ranking and extraction depth.*

**Tier 3 — the answer is spread across pages.**
No single page has it. Either you combine two independent sources — one number
from each — or the right source has to be picked out of a crowd of near-identical
wrong ones: SEO aggregators, stale mirrors, wrong region, wrong version. *Fails
on: coverage and precision at the same time.*

A question sits in exactly one tier. If it could plausibly sit in two, it's cut
rather than assigned by gut feel.

### What we hold steady across tiers

Difficulty must not smuggle in some other variable. Three are controlled, and each
gets reported alongside the results:

1. **Freshness.** Recency was run 1's dial, not this one. Within a question type,
   the tiers differ in *where the answer lives*, not *how recent it is*.
2. **Question length.** A longer question hands the retriever more to work with.
   If tier 3 questions are much wordier than tier 1, we've measured wordiness.
   Reported as average word count per tier.
3. **How we found the answer.** See section 5 — this is the one that matters most.

### The ladder itself can fail

The tiers are a claim about difficulty, and claims can be wrong. We test them
against the **keyless baseline** (`core/adapters/plain.ts`), which isn't one of
the providers being compared and so can't be shaped by any of them.

**The check:** the baseline should get steadily worse from tier 1 to tier 2 to
tier 3.

**If it doesn't, the tiers failed.** They're then labels rather than a dial, the
trend test is void, and we publish that. We don't relabel the questions and try
again.

---

## 5. The questions, and knowing the right answer

### How many

**54 questions: 3 tiers × 6 question types × 3 each.**

The six types are the existing ones — breaking news, how-to, product lookup, local
and geo, recent releases, live numbers. Every tier gets the same number of each
type, so difficulty and question type stay separate. Otherwise, if all the hard
ones happened to be pricing lookups, we'd just be re-measuring question type with
new labels.

Ships as `datasets/hard-tasks.json`, ids prefixed `ht-`. The prefix is required:
the run log has no column saying which set a row came from, and the prefix is the
only thing telling run 2's rows apart from the other two sets.

### We don't write a perfect answer. We write the facts and the page.

A model answer is prose, and grading prose against prose puts you right back to
rewarding whichever answer reads best. Instead, each question records:

- **the specific facts a correct answer must contain** — `$0.023 per GB-month`
- **the page each fact lives on** — that exact URL
- **the near-misses** — pages that look right and aren't, and why

Then the score is something anyone can check: did this provider return that page,
and did the text it pulled actually contain that number?

```jsonc
{
  "id": "ht-t2-pl-01", "type": "product_lookup", "tier": 2,
  "query": "...",
  "gold": {
    "facts": [ { "claim": "S3 Standard, first 50TB, us-east-1",
                 "value": "0.023", "unit": "USD/GB-month" } ],
    "pages": [ { "url": "https://...",
                 "why": "the only page stating it; the pricing landing page doesn't",
                 "same_as": ["https://..."],
                 "archived": "https://web.archive.org/web/...",
                 "checked": "2026-08-12" } ],
    "near_misses": [ { "url": "https://...",
                       "why_wrong": "us-west-2 pricing, and it outranks the right page" } ],
    "as_of": "2026-08-12",
    "how_often_it_changes": "slow",
    "why_this_tier": "not on the landing page; found on the /pricing/detail sub-tab",
    "found_via": "manual — vendor docs, no evaluated provider used"
  }
}
```

`near_misses` isn't decoration. It's the evidence that tier 3 questions were
*found* to be hard rather than *declared* hard, and it's the first thing a
skeptical reader will check.

None of this is shown to the judges.

### The rule that matters most

**Answers must be found using something other than the providers being tested.**
Manual browsing, vendor docs and changelogs, primary sources, a plain consumer
search. Never Firecrawl, Exa, Tavily, Bright Data, or an agent wired to any of
them.

If we find the answer page using one of the contestants, the whole question set is
tilted toward that contestant's index, and every number downstream is
contaminated. This is the most likely line of attack on this run, and `found_via`
is recorded per question so the claim can be checked rather than just asserted.

### What has to be done by hand

| Step | Can be assisted? |
|---|---|
| Drafting candidate questions | Yes |
| **Finding the answer page** | **No** — manual channels only |
| **Confirming it's really on that page**, saving an archive copy | **No** |
| Assigning the tier | Follows from what the search found; reason recorded |
| **Checking it doesn't duplicate the 48 or the 24** | **No** — read side by side |
| Checking the model can't already answer from memory | Yes — ask it with search off; if it gets it right, the question measures nothing and is cut |

Honest cost: about 15–25 minutes per hard question. **54 questions ≈ 12–20 hours by
hand.** That's the project. The code change is a day.

### Answers go stale

- Re-check every answer within 72 hours **before** the run, and again straight
  **after**.
- If an answer changed mid-run, that question is **flagged and reported
  separately**, never quietly dropped. Dropping rows after seeing results is the
  exact thing this document exists to prevent.
- A question that has to be replaced gets a **new id**, never a recycled one.

---

## 6. How the run works

### Held identical for every provider

Answer model `kimi-k2p6`, the same answer and judge prompts from
`core/controls.ts`, 8 sources per call, full page extraction, no date filter.
Providers: Firecrawl, Exa, Tavily, Bright Data, plus the keyless baseline, which
is not a contestant and only exists for the difficulty check in section 4.

### One fetch per question, not five

**54 questions × 5 arms × 1 fetch = 270 fetches.**

Run 1 fetched everything five times to average out noise. Going back over that
run's own log, that was the wrong place to spend the money:

```
                  same links every time?    score wobble between fetches
Firecrawl              94% identical                 0.65
Exa                    96% identical                 0.65
Bright Data            12% identical                 1.51
Tavily                  0% identical                 1.19

overall wobble between fetches                       1.05
wobble when the links were identical                 0.69
average disagreement between the two judges          2.13
```

Three things follow, all from run 1's own data:

1. **For Firecrawl and Exa, fetching again buys almost nothing.** 94% and 96% of
   the time, all five fetches came back with exactly the same links. (These were
   genuinely separate fetches — `core/credibility.ts:385` puts the repeat number
   in the cache key precisely so repeats aren't served from cache.)
2. **The noise is in the grading, not the fetching.** Even when the links were
   identical, scores still moved by 0.69. And the two judges disagreed with each
   other by 2.13 points out of 10 on the very same page — **the panel disagrees
   with itself more than re-fetching does.**
3. Fetching costs the scarce thing (Firecrawl credits). Judges cost the cheap
   thing (tokens).

So: fetch once, spend the savings on more questions and more judges. This also
removes run 1's budget problem — 54 Firecrawl calls fits inside a 5,000-credit
plan where 270 didn't.

**Retries aren't repeats.** With one fetch per question, a transient error has no
sibling to fall back on, so we retry up to 3 times with backoff on timeouts, 5xx
and rate limits. Retries don't count as repeats and don't enter any noise
estimate. Bright Data failing a quarter of its run-1 calls makes this necessary.

### The repeat-fetch sample

Repeats stay, for a different job: **measuring how consistent each provider is**,
which the numbers above show is a big, unreported difference between them.

**18 questions (6 per tier) fetched 3 times each.** The main fetch counts as the
first, so it's 180 extra fetches.

That gives two things. **How often each provider returns the same links** — a
provider whose results churn 50% between identical calls gives agent builders
non-repeatable behaviour, and nobody publishes this number. And **how noisy each
tier is**, which is what makes the trap in section 3 testable. Run 1's noise
figure was measured on easy questions and can't be assumed to hold on hard ones —
and if noise grows with difficulty, "the gap widens" and "the noise widens" look
identical on a chart.

### Budget

| | Firecrawl calls | credits (20–60 each, per run 1) |
|---|---|---|
| Main run | 54 | 1,080 – 3,240 |
| Repeat sample | 36 | 720 – 2,160 |
| **Total** | **90** | **1,800 – 5,400** |

The top of that range is over a 5,000/month plan. **If the budget binds, the
repeat sample shrinks from 6 questions per tier to 4.** The 54 questions are never
cut and repeats are never traded for questions. Whichever happened is stated in
the results.

---

## 7. What we score

**The main number: did it return the right page?** Yes or no, per question per
provider, checking whether any of the recorded answer pages appears among the 8
sources returned.

This is what run 2 turns on, and the reason is the judge disagreement above. When
two judges differ by 2.13 points out of 10, a judge-based headline carries more
error than the thing it's trying to detect. This removes the judge from the main
result completely. It also answers the standing objection to run 1 — that a judge
grading obscure answers is really grading how confident they sound — by not asking
a judge.

*Matching rule, fixed now:* lowercase the host, drop `https://`, `www.`, anything
after `?` or `#`, and trailing slashes; match on host plus path. Each answer page
can list equivalents (doc mirrors, versioned URLs) written down **before** the run.
No loosening this rule after seeing results.

**The second number: did the text it pulled contain the fact?** Checked by
matching the recorded value against the extracted page content. This separates
*found the page* from *actually read the page* — a distinction the current judge
blurs into "extraction quality", and one several products are sold on.

**Kept for continuity: the two-judge scores**, unchanged, so run 2 sits beside run
1 on the same axis. Not the headline.

**Added and labelled: two more judges.** With judges disagreeing as much as they
do, four judges roughly halve that error where no amount of re-fetching would.
They're reported alongside the two-judge numbers, never instead of them. The two
extra judges must be from different model families, must reliably return valid
JSON, and `gpt-oss` is excluded — it graded badly on this rubric before.

**Reported but not tested:** consistency between fetches, error rates by step,
latency, source age.

---

## 8. How it gets analysed

All of this is fixed now, before any run-2 data exists.

**What "the gap" means.** For each question, take all 6 possible pairs of the 4
providers, and average how far apart each pair is. Then average that within each
tier. *Not* best-minus-worst — that grows with noise, grows with the number of
providers, and is decided by whichever provider happens to be extreme. It's
reported as a secondary number only.

For the main yes/no score, the gap reads as **how often two providers disagree
about whether the right page was found** — which is directly interpretable.

**Error bars.** Resample the *questions* (not the fetches, not the judge verdicts)
10,000 times and take the middle 95%.

**The trend test.** Plot the gap against tier — tier 1, 2, 3 — and fit a line.
Report the slope and its error bar. Run it three times: on the main yes/no score,
on the fact-in-the-text score, and on the two-judge score for continuity.

**The smallest trend this could see.** Roughly **10 percentage points of extra
disagreement per tier step**, on the assumptions we have going in. This gets
recomputed from the real data and published alongside the result. Anything smaller
gets reported as *too small for this many questions to see*, not as *absent*.

**Separating a real gap from a noisy one.** Using the repeat sample, compute how
noisy each tier is and plot the gap and the noise on the same axis. The idea is
only supported if the gap grows **and** grows faster than the noise. If the gap
grows but noise keeps pace, the finding is reported as *apparent separation is a
noise artifact*.

### What would prove the idea wrong

Any one of these:

1. The error bar on the trend line includes zero.
2. The trend goes the other way.
3. The difficulty ladder fails its check (section 4) — the baseline doesn't get
   worse as tiers get harder.
4. The gap grows but the noise grows just as fast.

**A flat result gets published with the same prominence and the same effort as a
positive one.** It would be a real finding: that difficulty doesn't separate search
providers, and that run 1's headline — good pages don't predict good answers —
holds across difficulty rather than being an artifact of easy questions.

There's no backup analysis that rescues a flat result. Anything interesting we
notice afterwards gets labelled as such and is not presented as a test of this
idea.

---

## 9. Failures, and who they're charged to

Per-step error tagging is unchanged. The new scores need their own rules, fixed
now:

| What happened | How it's scored |
|---|---|
| Provider returned results, none was the right page | **Miss.** A real retrieval failure. |
| Provider errored out after 3 retries | **Miss**, and counted in the error table. |
| The answer or judge step failed | Dropped from judge scores only; the page check still stands, since it doesn't involve the model. |
| Failure tagged `unknown`, or traced to our own code or account | **Dropped entirely, charged to nobody.** |
| Ran out of credit | Dropped; reported separately as our limit, not theirs. |

The last two are run 1's rule and they hold. Every dropped row is counted and
published, so the denominator is always visible.

---

## 10. What gets published either way

1. The gap-versus-difficulty chart for all three scores, with error bars and the
   noise level drawn on the same axis.
2. The trend line, its error bar, the smallest trend we could have seen, and
   whether it beat the noise.
3. The difficulty-ladder check, including if it failed.
4. How consistent each provider was, by tier.
5. The full error table and every dropped row.
6. `datasets/hard-tasks.json` and the complete answer key.
7. Every balance check from section 4, including any that came out lopsided.
8. The changes log below, even if it's empty.

---

## 11. Changes after the tag

Anything that changes after the tag gets **added here**, never edited into the
plan above. Each entry says what changed, when, why, and whether we'd seen results
yet.

*(empty)*

---

## 12. Before this becomes binding

The `prereg-v2` tag goes on only when all of these are true:

- [ ] `datasets/hard-tasks.json` complete — 54 questions, 3 per tier per type, `ht-` prefix, unique ids
- [ ] Answer key complete for all 54, every page checked and archived, every `found_via` recorded
- [ ] Duplicate check against the 48 and the 24, done by hand
- [ ] Memory check run; any cut questions listed here
- [ ] Balance checks computed and written into section 4
- [ ] The two extra judges named here: `__________`, `__________`
- [ ] Fingerprint of the answer key recorded here: `__________`
- [ ] This document published somewhere with a timestamp anyone can verify

**On the answer key.** The questions go public at tag time. The answer key — pages,
facts, near-misses — is published as a *fingerprint* at tag time and released in
full with the results. That way nobody gets a target list in the window before the
run, but "we didn't adjust the answers after seeing results" is something you can
check rather than something you have to take our word for.

**No provider call for this run happens before the tag exists.**
