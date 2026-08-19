# Run 2 — working draft

> Numbers here are final. Judging finished at 22,457 page ratings and 4,886 set
> verdicts, three judges, nothing unjudged.
>
> The `[YOURS]` markers are sentences I should not write. They are the parts only
> you know — what you paid, what broke, what you expected and did not get.

---

## The opening

`[YOURS — one or two flat sentences. Do not open with a thesis paragraph.]`

The README has the honest version already: you could not get a straight answer
about which search API to use, and the answers you found were vendor benchmarks.
Run 1 tested four providers on 48 questions. This is eight providers on 204,
half of them written to be hard.

---

## What was measured

204 questions, asked once to each of eight search APIs on one day, caching off.
Every page came back to the same three judges. Only the search provider varied.

```
204 questions  ×  8 providers                    =   1,631 searches
               ×  8 results each                 =  12,954 question-page pairs
               → same page from several arms     =   7,496 unique pairs
               ×  3 judges                       =  22,488 page ratings
             +   1,631 sets × 3 judges           =   4,893 set verdicts
```

Two things readers assume wrongly.

**The judge never answers the question.** It sees one question and one page and
says whether that page helps: 0 no, 1 on topic but useless, 2 part of the answer,
3 answers it. It is never asked what the answer is. Run 1 found source quality
and answer quality correlate at r = 0.16, so grading the answer mostly grades
your own model.

**Eight results each is a control.** Everyone is asked for the same number.

### The two scores

**Set rating is the headline.** Give a judge all eight pages one provider
returned and ask whether someone could answer from those alone. A per-page
average cannot tell you that. Eight pages each holding a third of the answer and
eight holding nothing average out the same.

**Page rating is the mechanism underneath.**

`[YOURS — the set judge changed mid-run.]` It first reused run 1's prompt, which
grades whether sources look good. On `r2u-14`, a question with no answer
anywhere, it said 5/10 while the page judge rated every page 0 or 1. Good sources
that cannot answer. Your words.

---

## What the numbers say

### The providers separate

| provider | set | ±95% | base | hard | base→hard |
|---|---|---|---|---|---|
| perplexity | 2.768 | 0.068 | 2.331 | 2.329 | −0.003 |
| brave | 2.611 | 0.081 | 2.088 | 2.019 | −0.069 |
| parallel | 2.556 | 0.088 | 1.929 | 1.923 | −0.005 |
| exa | 2.549 | 0.086 | 2.097 | 1.948 | −0.149 |
| tavily | 2.149 | 0.109 | 1.682 | 1.419 | −0.263 |
| serper | 2.123 | 0.104 | 1.590 | 1.418 | −0.172 |
| firecrawl | 2.064 | 0.112 | 1.560 | 1.304 | −0.255 |
| bright_data | 1.950 | 0.105 | 1.482 | 1.285 | −0.196 |

Brave, Parallel and Exa are one group. Their intervals overlap and the ordering
between them means nothing. Perplexity sits clear above, the bottom four clear
below.

Run 1's pilot measured a provider gap around 1%. This is a full rung on a
four-rung scale.

### The gap widens where it should

Best to worst goes from **0.850 on the base questions to 1.043 on the hard ones**,
23% wider. Easy questions make providers look alike.

The mechanism is not that the leaders improve, it is that the bottom falls out.
Perplexity and Parallel lose nothing going from base to hard. Tavily, Firecrawl
and Bright Data lose a quarter of a rung.

### Judge choice moves every number and no ranking

All three judges, three different labs, agree on the order — with one swap.
Sonnet and glm put Brave above Exa, terra puts Exa above Brave. Positions 1, 4,
5, 6, 7 and 8 are identical for all three.

The variance breaks down as **provider 23.1%, question 45.7%, provider × question
21.4%, judge 2.2%.** Which judge you picked explains a fortieth of what varies.
Pairwise agreement is kappa 0.51 to 0.55, moderate on a four-point scale.

Pick a different judge and every absolute number moves. The ranking does not.

### The result survives throwing the scale away

The obvious objection to a 0–3 rubric is that the scale invented the gap. It did
not. Score it as binary relevance instead — a page either counts or it does not —
and the order is identical under both thresholds:

| provider | only rung 3 counts | rung 2 or 3 counts |
|---|---|---|
| perplexity | 48.3% | 81.8% |
| brave | 33.9% | 72.8% |
| exa | 30.3% | 70.9% |
| parallel | 29.4% | 67.7% |
| tavily | 20.2% | 50.5% |
| serper | 17.3% | 48.5% |
| firecrawl | 15.9% | 44.6% |
| bright_data | 15.5% | 43.2% |

Strict scoring widens Perplexity's lead. It returns a page that fully answers at
1.4 times the rate of anyone else, and the mean hides that because rung 2s
dilute it.

### Redundant results and complementary ones

Having both scores gives you a third number nobody else computes: how much more
the whole set answers than its average page suggests.

| provider | page | set | lift |
|---|---|---|---|
| perplexity | 2.226 | 2.768 | +0.542 |
| exa | 1.938 | 2.548 | +0.610 |
| brave | 1.967 | 2.611 | +0.644 |
| parallel | 1.864 | 2.556 | +0.691 |
| firecrawl | 1.361 | 2.063 | +0.701 |

High lift means the eight pages cover different parts of the answer. Low lift
means they repeat each other. Perplexity has the lowest lift of anyone and the
highest set score — its pages are 48% rung-3, so each already answers and
assembling them adds little.

Exa and Parallel end up level on set from opposite directions. Exa's individual
pages are better; Parallel's fit together better.

### The leaderboard inverts on questions with no answer

Twelve questions have no answer anywhere — a Postgres setting that does not
exist, a Docker option never added. Scoring **low** is the good outcome.

| bright_data | 0.370 |
| firecrawl | 0.406 |
| tavily | 0.447 |
| serper | 0.466 |
| **exa** | **0.559** |
| perplexity | 0.646 |
| parallel | 0.647 |
| brave | 0.678 |

A high score means the provider found a convincing near-miss. Asked for the
default of `max_parallel_vacuum_workers`, which does not exist, one arm returned
a page about `max_parallel_maintenance_workers` — a real setting, real default —
and a judge called it a direct answer.

Perplexity is the best at finding answers and among the worst at not
manufacturing the appearance of one. Exa is the most restrained of the four
providers that rank well. For an agent that matters more than the leaderboard,
because nothing downstream catches it.

It indicts the judge too. glm marked that Postgres page down and said the
parameter name did not match. Sonnet did not. The metric mixes whether a provider
surfaced a trap with whether the judge fell in, and terra falls in more often
than the other two.

### Price buys nothing

| provider | $/query | this run | set |
|---|---|---|---|
| firecrawl | $0.0856 | $17.47 | 2.064 |
| tavily | $0.0540 | $13.83 | 2.149 |
| exa | $0.0141 | $2.88 | 2.549 |
| bright_data | $0.0129 | $2.64 | 1.950 |
| perplexity | $0.0050 | $1.02 | 2.768 |
| brave | $0.0050 | $1.02 | 2.611 |
| parallel | $0.0050 | $1.02 | 2.556 |
| serper | $0.0010 | $0.20 | 2.123 |

$40.08 of retrieval and an 86× spread for the same 204 questions. The three
cheapest take three of the top four places.

Serper matches Tavily's set score at a fifty-fourth of the price. It returns
links and snippets and never page content, so if you already have a scraper,
Serper plus your own fetch beats paying anyone for bundled extraction.

`[YOURS — the Firecrawl credit line. One run took 3,493 credits, about 70% of a
5,000-credit month, in a day. You paid $25 for those credits. It lands harder
from you than from the table.]`

### "Page text" means something different from everyone

| | markdown | headings | links | images | tables |
|---|---|---|---|---|---|
| firecrawl | 99% | 82% | 90% | 65% | 9% |
| tavily | 98% | 87% | 91% | 73% | 7% |
| bright_data | 92% | 69% | 90% | 78% | 0% |
| exa | 91% | 89% | 7% | 3% | 14% |
| parallel | 91% | 89% | 36% | 0% | 2% |
| perplexity | 63% | 24% | 1% | 0% | 15% |
| brave | 1% | 1% | 0% | 0% | 0% |

Brave is not returning pages. Its content is search snippets joined together —
the HTML entities are undecoded and the fragments end in the SERP's own ellipsis.
Fine for grounding a summary, no use to an agent that has to read a document.
This is what Claude's web search runs on.

Exa keeps structure and drops links: 89% of its pages have headings, 7% have a
link. Perplexity and Parallel drop images entirely. Bright Data keeps the most
images and no tables at all.

Nobody returns video. Three to six per cent of Bright Data and Firecrawl pages
mention a YouTube link and that is the whole story — no transcripts, no captions.
If your questions need video, none of these eight get you there.

None of this appears in a relevance score, and it decides what you can build.

---

## What this cannot see

`[YOURS — you said the surprise was how much the pooling and truncation hid. Say
it here, in your words, before anyone says it for you.]`

Every source was cut to 1,600 characters before a judge saw it. How often that
bit:

| firecrawl | 98% |
| tavily | 99% |
| exa | 93% |
| bright_data | 92% |
| brave | 77% |
| parallel | 43% |
| perplexity | 40% |

A provider returning a 40KB article and one returning 1,600 characters of
stitched snippets reach the judge the same size. This measures which pages you
get back. It is blind to how deeply a provider extracts them.

For Firecrawl that is the result rather than a caveat beside it. Measured on
which URLs it finds, Firecrawl comes 7th at 86 times the cheapest arm. Measured
on what it returns for a URL you already have, this run says nothing, and
extraction is what Firecrawl sells.

**Providers overlap.** The same page often comes back from several of them. It is
rated once, and the rating counts for everyone who returned it, using the longest
version anyone returned. Seven in ten pages came from exactly one provider, and
15 of 7,496 came from all eight. These indexes overlap far less than you would
guess.

**Nobody abstains.** All eight returned their eight results on the unanswerable
questions, same as everywhere else. Zero empty results. Deciding there is no
answer is the caller's job.

---

## What I would do differently

`[YOURS — the last thing I need and the one I should not guess.]`

Candidates from the data:

- Hold the URLs fixed and vary only the extraction. 2,406 pages came back from
  two or more providers, so the comparison is already paid for. That measures the
  axis this run is blind to.
- Store provider-native relevance scores. Exa returns one. Without it there is no
  way to test whether a threshold lets a caller abstain.
- `[YOURS — the batch bug cost about $19 for nothing and was found by running the
  thing rather than reading it.]`

---

## Method

- 204 questions: 96 base, 96 harder on purpose, 12 unanswerable as an honesty
  check. Frozen before the run.
- Judges calibrated against human-settled pairs first. All five candidates
  passed, none rated a keyword-stuffed page above 0. Three were used.
- Fetched 2026-08-17 and 08-18, caching off. Bright Data throttles above one
  concurrent request and needed a slower repair pass that crossed midnight.
- 1,631 of 1,632 fetches clean. The miss is Firecrawl timing out at 300 seconds,
  checked against their API directly.
- Keyless search is excluded — captcha-blocked after eight consecutive failures
  and no successes. A demonstration of the free floor, not a measured provider.
- Prices are pay-as-you-go rates off the author's own billing pages, not
  out-of-pocket. Free credits are a fact about one account.

Every rating, with the judge's own sentence, is in the explorer.
