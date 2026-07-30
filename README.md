# sourcery

**A retrieval-eval harness for web-search APIs.** Same query, same answer model, same judge — swap only the retrieval provider, and measure what actually changes.

Built to answer a question I couldn't find a straight answer to: *if you're building a RAG or research agent on top of a web-retrieval API, does the provider you pick actually matter — and how would you know?*

---

## First, the unit: an arm

An **arm** is one `fetch → answer → judge` pipeline in which **exactly one variable differs**. The term is borrowed from clinical trials, and so is the discipline: you change one thing, hold everything else fixed, and repeat enough times to tell signal from noise.

So **480 arms = 48 queries × 2 providers × 5 repeats.** That is not the same search run 400 times — it's 48 distinct questions, each fetched five separate times per provider, every fetch independently graded.

The five repeats are the whole reason the headline below is trustworthy. Re-running an identical query moves `retrieval_score` by about **1.0 point** (`seed_std_mean = 1.04`) — while the gap being measured was **0.22**. The thing I was trying to detect was five times smaller than the error bar on a single measurement of it. Without repeats you cannot know that, and you will publish the noise.

---

## Two findings

### 1. The gap that wasn't

The most useful thing this eval did was **overturn its own first result.**

An early pass — 12 queries, one run, a single judge — had Bright Data writing better answers than Firecrawl by 2.6 points, with a tidy mechanistic story to explain it. So I built the machinery to check whether that was real: the full 48-query set, 5 fresh fetches each, both providers, every arm graded by a **two-judge panel** — **480 arms, 417 paired verdicts, 95% confidence intervals.**

Tested properly, the quality gap vanished.

| | Bright Data | Firecrawl |
|---|---:|---:|
| **Retrieval quality** (0–10, 95% CI) | 4.78 ± 0.44 | 4.56 ± 0.52 |
| **Answer quality** (0–10, 95% CI) | 6.55 ± 0.81 | 6.99 ± 0.69 |
| Sources returned / arm | 7.7 | 8.0 |
| Sources extracted | 33% | **90%** |
| Median source age | 286 days | 299 days |
| Median latency | 76s | 52s |
| **Arm failure rate** | **25%** | **0.8%** |
| Queries with data (of 48) | 46 | 48 |

*Answer model (Kimi) held constant across every arm; judges are a two-model open panel (GLM + DeepSeek). Full computed summary: [`docs/s2-summary.json`](docs/s2-summary.json).*

On both quality scores the confidence intervals **overlap** — the two providers are statistically indistinguishable, and the 2.6-point answer gap from the n=12 run is gone. That gap was underpowering, not signal. An eval's first job is to not fool you, and catching my own earlier conclusion is the point of building one.

Three things *do* survive the intervals:

1. **Reliability is the real difference.** Firecrawl failed 2 of 240 arms (0.8%). Bright Data failed 61 of 240 (25%) — its SERP endpoint intermittently returns non-JSON under concurrency, which a retry loop softens but doesn't fix. The providers tie on answer quality; they do not tie on *returning an answer at all.*

2. **Firecrawl extracts far more, and it doesn't move quality.** Firecrawl pulls usable text from 90% of its sources, Bright Data from 33% — the one large gap that replicates. But it buys no measurable answer-quality edge (6.99 vs 6.55, overlapping). The earlier story that *more* extraction produced *worse* answers was noise; the honest version is that extraction volume and answer quality are decoupled here.

3. **Neither is good at freshness.** Every query asks for the latest / current / newest thing; the median retrieved source is **~290 days old** for both. Fresh retrieval is an unsolved, hard problem — measured here, not asserted.

And one finding about the method itself: **the judge moves the score more than the retriever does.** Re-running a query shifts retrieval_score by ~1.0 on average; swapping the judge model shifts it by ~2.0, and the two judges agree at only r=0.60. That is why the single-judge n=12 result was fragile — and why any benchmark that grades with one model and prints no interval earns side-eye.

### 2. The answer barely depends on what was retrieved

This is the one I didn't expect, and it's the reason `retrieval_score` exists.

**Across 417 paired arms, `retrieval_score` and `answer_score` correlate at r = 0.16.**

Essentially not at all. A provider can return stale, off-topic, half-extracted junk and the answer built from it still scores well — because the answer model is answering from what it already knew, not from what the retriever handed it. If you grade a retrieval provider by the quality of the answer downstream of it, you are mostly grading the answer model.

It replicates. Running six queries across **four** providers — Firecrawl, Bright Data, Tavily and Exa, 72 arms, a different judge configuration — gives **r = 0.18**:

| provider | retrieval (95% CI) | answer (95% CI) |
|---|---:|---:|
| exa | 4.11 ± 1.68 | 8.28 ± 3.76 |
| firecrawl | 3.39 ± 1.44 | 6.11 ± 2.27 |
| bright_data | 2.89 ± 2.39 | 7.06 ± 3.00 |
| tavily | 1.94 ± 1.41 | 8.17 ± 2.47 |

**Read the intervals, not the order.** Every one of them overlaps every other. Six queries cannot separate four providers, and this table is here as evidence for the decoupling — the same shape on four backends — not as a ranking. Tavily is the vivid case: the *lowest* retrieval score in the set and the second-*highest* answer score. Its sources were the worst; its answers read fine.

Rank these providers off this table and you would be repeating precisely the mistake that finding #1 is about. I'm not going to do that, and neither should you.

---

## Why the eval is built this way

The design problem with judging retrieval is that **the judge can cheat.** Ask a model to score an answer on a topic it already knows, and it will happily reward a response that came from parametric memory rather than from anything the retriever actually fetched. You end up measuring the answer model, not the retriever.

That is not a hypothetical. It's the r = 0.16 above — the failure mode caught in the act, on four different providers.

So the dataset is built to make it impossible:

- **The primary metric can't be answered from memory.** `retrieval_score` grades the *fetched sources* — fresh? on-topic? real? — not the answer, so a judge can't reward what it already knew instead of what the retriever found. (The default single-judge run also uses a stale model, `gpt-4o-mini`, Oct-2023 cutoff against a 2026 reference date, which protects the secondary `answer_score`; the credibility run swaps in a current-model panel because measuring inter-judge agreement needs capable judges.)
- **Every query demands fresh information** — 6 categories × 8 queries: `breaking_news`, `how_to`, `product_lookup`, `local_geo`, `recent_release`, `numeric_live`.
- **Queries are phrased as "latest / current / newest," never pinned to a version, date, or figure** — so the dataset doesn't rot as the world moves. It's still a valid eval next year.

Two separate scores, because retrieval and answering fail differently: `retrieval_score` grades the *sources* (fresh? relevant? real?), `answer_score` grades the *answer built from them*. A run can retrieve well and answer badly, and — as it turns out — the reverse is common enough to be the default.

Dataset and reasoning: [`core/eval-dataset.ts`](core/eval-dataset.ts) · Scoring: [`core/judge.ts`](core/judge.ts), [`core/retrievalJudge.ts`](core/retrievalJudge.ts)

---

## Why every score is so low

Mid-4s out of 10 looks like a broken harness. It isn't, and the reasons are worth stating before you conclude that these are bad products:

1. **The dataset is adversarial on purpose.** Every one of the 48 queries demands the newest thing that exists. Measured result: the median retrieved source is ~290 days old for both providers. That's the finding, not a bug in the grading.
2. **`retrieval_score` grades the sources, not the answer.** Eight results where two are fresh and on-topic is a 4, however good the prose downstream reads.
3. **It's single-shot.** One query in, eight results, done. No re-query, no follow-up, no reading one page and deciding to fetch another. That's a deliberate control — it's the only way to isolate the retrieval call — but it is not how a competent agent actually works, and the gap between the two is large.
4. **The queries aren't representative** — see below.

The per-category numbers say the same thing more precisely (retrieval score, Firecrawl / Bright Data): both are weakest on `local_geo` (3.84 / 3.67) and `breaking_news` (4.17 / 3.82), and strongest on `numeric_live` (5.54 / 5.58) and `how_to` (4.88 / 6.11). Breaking news sitting near the bottom is the uncomfortable one — it's the category you'd most want a fresh-retrieval product to win. Per-category intervals are wide (±0.9 to ±1.8), so read these as texture, not as a leaderboard; the full breakdown is in [`docs/s2-summary.json`](docs/s2-summary.json).

---

## What this dataset isn't

**Nobody actually points a retrieval agent at these queries.**

The 48 are freshness probes — *"What is the latest major development in the ongoing Russia-Ukraine war?"*, *"What is the current stock price of NVIDIA?"* Phrasing them that way was a deliberate call for **durability**: nothing is pinned to a version or a date, so the set doesn't rot and it's still valid next year. But that durability was bought at the cost of realism. Real retrieval work looks like:

- *"Find the open backend engineering roles at <company>, with comp bands"*
- *"Price, storage options and stock for <product> on <store>"*
- *"What are the current per-token pricing tiers for <model>"*
- *"Which of these 30 companies have raised since January, and how much"*

Those are jobs with a right answer sitting on a specific page, and they're what you'd actually build a research agent to do. The 48 are none of that. So part of why the scores are low is that the questions are both hard *and* unrepresentative — a reader who sees 4.5/10 and concludes "these providers are broken" has been misled by my dataset design, not informed by it.

The fix is **additive, not a rewrite**: a second dataset of real retrieval tasks, selectable by flag and reported separately, with `core/eval-dataset.ts` left exactly as it is. The 480-arm result above is anchored to those 48 queries; quietly editing them would invalidate the headline finding rather than improve it. Two datasets that disagree is a more interesting result than either alone.

That work isn't done. This section is the caveat until it is.

---

## What I'd defend, and what I wouldn't

An eval you can't trust is worse than no eval.

- **I'd defend:** the reliability gap (25% vs 0.8% over 240 arms each is not noise), the extraction gap (90% vs 33%), the shared freshness weakness (~290-day median across 46–48 queries and both judges), that judge choice dominates re-run noise, and the retrieval/answer decoupling (r = 0.16 over 417 arms, r = 0.18 on an independent four-provider set).
- **I wouldn't defend:** any claim that one provider retrieves *better* — every confidence interval overlaps, in both the two-provider and the four-provider table, full stop. Nor any per-category ranking from the four-provider runs: six queries and three repeats is an illustration, not a measurement. And Bright Data's 25% failure rate is measured under this harness at concurrency 6; a gentler caller sees fewer, even though the bad-proxy-exit mechanism is real.
- **I'd hold loosely:** the absolute score levels. They're a property of this dataset's difficulty, and the section above explains why that difficulty is unrepresentative.
- **Now closed:** the old "n=12, single run, one judge, no CIs" caveat this section used to carry. It's been replaced by 480 arms, a two-judge panel, and intervals — which, usefully, reversed the headline it was hedging.

**On provider neutrality:** the 480-arm headline compares Bright Data and Firecrawl because those were the only two API keys I had when I ran it — not because they're the two that matter. Tavily and Exa were keyed later and are measured on the smaller set. If you want a different pairing, the whole point is that you can run it yourself: `--values firecrawl,exa`.

How it's built and what each control holds constant: [`docs/`](docs/).

---

## Run it

The package is `sourcery-eval` on npm; the command it installs is `sourcery`.

```bash
npx sourcery-eval init               # scaffold config + .env.example
npx sourcery-eval providers --check  # what's registered, what keys you need,
                                     # and whether those accounts will serve a run
npx sourcery-eval run "<query>"      # one query, arms side by side
npx sourcery-eval batch              # the full 48-query eval set → per-query heatmap
npx sourcery-eval report             # self-contained HTML from the run log
```

(From a clone: `npm install`, then `npm run sourcery -- run "<query>"`.)

Config, env (`.env.local`), and results (`.sourcery/`) are all read and written
relative to the directory you run from — run it where your project lives.

You need one LLM key (for the answer and judge steps) plus at least one retrieval provider's key. The default arms are `bright_data` and `firecrawl`; with neither key set, a first run produces a scorecard of failed arms — honest, but not what you want. Pick the arms you have keys for instead: `--values firecrawl,tavily`. And `providers --check` is worth running before anything long: a key being *set* doesn't mean the account still has quota, and finding that out 200 arms into a two-hour run is expensive.

There's also a `plain` arm that needs no retrieval key at all — a keyless SERP with a bare `fetch()`. Treat it as a way to kick the tyres, not a benchmark: keyless search rate-limits aggressively and the block outlasts your patience. Details in [`docs/providers.md`](docs/providers.md).

Every run appends to `.sourcery/runs.jsonl`, which is the contract — the terminal scorecard and the HTML report are both just views over it.

The batch heatmap is the useful one: it shows *which query types* a provider fails on rather than a single average, and query type turns out to matter more than provider identity.

### Know what a run costs before it spends

Retrieval APIs bill per call and a full batch is not cheap, so every run can be priced first:

```bash
sourcery batch --dry-run                  # itemised estimate, spends nothing
sourcery batch --max-credits 400          # refuses to start if the estimate exceeds this
```

Fetches are cached for 24h, so re-judging a query you've already retrieved costs nothing — and the estimate nets cached arms off before quoting you.

## Providers

Five retrieval arms ship in the box:

| id | Status | Keys needed | Shape |
|---|---|---|---|
| `bright_data` | **measured** — 240 arms | 3 (token + 2 zone names) | Google SERP, then a separate unblocked fetch per URL |
| `firecrawl` | **measured** — 240 arms | 1 | search + scrape in one call |
| `tavily` | **measured** — 18 arms | 1 | RAG-tuned index, optional raw page content |
| `exa` | **measured** — 18 arms | 1 | neural index; the only arm with reliable native publish dates |
| `plain` | *baseline only* | **none** | keyless SERP + bare `fetch()` — the free baseline |

The arm counts are the point of the status column: 240 arms supports a confidence interval, 18 supports an anecdote. Both are labelled so you can tell which you're reading.

An adapter is one function — `(query, config) => { sources, context }` — plus a row in the registry. That's the whole interface, and it's about 40 lines for a typical JSON search API. Setup recipes, per-provider quirks, credit arithmetic, and a complete worked example: **[`docs/providers.md`](docs/providers.md)**.

`plain` deserves one caveat up front: keyless search blocks sustained automated use — measured here, a block survived 15 minutes of complete silence and did not lift. So it's for trying the tool, not for benchmarking. That unreliability is itself informative: availability under automated load is a large part of what a paid provider sells.

### What an arm actually costs, measured

Running this eval produced an incidental result about Firecrawl's billing that's worth writing down, because the published per-call pricing doesn't obviously predict it.

I'd assumed 10 credits per arm. It's **20**. Three controlled `/v2/search` calls at `limit: 8`, diffing `remainingCredits` between them, isolate where it goes:

| request | credits | what it isolates |
|---|---:|---|
| `sources: ["web"]`, no scrape | 2 | search alone |
| `sources: ["web"]` + markdown | 10 | +8 → 1 credit per page scraped |
| `sources: ["web","news"]` + markdown | **20** | +10 → a *second* search **and** 8 more scrapes |

Asking for two source types buys two searches *and* two sets of scrapes. Real arms bill **20–65**, going higher when Firecrawl escalates to a browser rendering path — government statistics pages were consistently the worst. That's the difference between a 48-query batch costing 1,000 credits and costing 5,000, which is why `--dry-run` exists. Method and the levers that bring it down (`extraction: "raw"` → ~4/arm; dropping `"news"` → ~10/arm, at the cost of native publish dates) are in [`docs/providers.md`](docs/providers.md).

## Use it from an agent

sourcery ships an MCP server on the same binary, which makes the eval something an agent can consult rather than something a human reads afterwards. Two tools:

| tool | cost | what it does |
|---|---|---|
| `which_provider` | one LLM call, **no retrieval** | Classifies a query into one of the six types and returns the provider that scored best on that type in the eval history. Use it to *pick* a backend. |
| `evaluate_retrieval` | slow, metered, live provider + LLM calls | Runs one query across several providers with everything else held constant, and returns per-provider scores. Use it to *prove* one. |

The useful pattern is the cheap one: before an agent spends a retrieval call, it asks which backend has actually performed best on this kind of question and routes accordingly — evidence instead of a hardcoded default, for the price of one classification. `which_provider` falls back to the shipped 480-arm summary when you have no local run history, so it's useful on first install.

```bash
sourcery mcp    # stdio MCP server
```

Server and tool definitions: [`mcp/server.ts`](mcp/server.ts).

## Bring your own model

**The retrieval provider is the variable. The model is yours to choose.**

The answer step and both judges run through a single provider-agnostic seam, so you can point the whole eval at any OpenAI-compatible backend — including one running on your own hardware. A model is a `provider/model` ref; a bare id (`gpt-4o-mini`) means OpenAI.

```bash
# OpenAI (needs OPENAI_API_KEY)
sourcery run "<query>" --model gpt-4o-mini

# Fireworks (needs FIREWORKS_API_KEY) — the scaffolded default from `sourcery init`
sourcery run "<query>" \
  --model fireworks/accounts/fireworks/models/kimi-k2p6 \
  --judge fireworks/accounts/fireworks/models/deepseek-v4-pro
```

This matters more than it looks. An eval of *your* retrieval stack is only meaningful if it runs the model you actually ship — and "which model is best" is a question this tool deliberately declines to answer for you. You only need the key for the provider you actually use. Adding another OpenAI-compatible backend (Together, Groq, vLLM, …) is one row in [`core/llm/`](core/llm/).

The judge defaults to a stale model on purpose: the anti-cheat needs its cutoff to predate the queries, so a fresher judge only affects `answer_score`, never the primary `retrieval_score`.

## Stack

TypeScript · a Commander CLI over a framework-free [`core/`](core/) · an MCP server on the same binary · retrieval adapters in [`core/adapters/`](core/adapters/)

---

MIT © [Sameer Himati](https://sameerhimati.com).
