# sourcery

A retrieval-eval harness for web-search APIs. Same query, same answer model, same judge, swap only the retrieval provider and measure what actually changes.

I built it because I couldn't find a straight answer to a question I had while building a research agent: does the retrieval provider you pick actually matter, and how would you know?

## Quickstart

The package is `sourcery-eval` on npm. The command it installs is `sourcery`.

```bash
npx sourcery-eval init               # walks you through keys, writes .env.local, ends on a real run
npx sourcery-eval providers --check  # which providers are registered, which keys you have,
                                     # and whether those accounts will actually serve a run
npx sourcery-eval run "<query>"      # one query, every provider side by side
npx sourcery-eval batch              # the full 48-query set, gives you a per-query heatmap
npx sourcery-eval report             # self-contained HTML from everything you've run
```

From a clone it's `npm install` and then `npm run sourcery -- run "<query>"`.

You need two kinds of key. One LLM key for the answer and judge steps, and at least one retrieval provider key for the thing being measured. `init` sets both up and finishes by running a real query so you know it works. If you'd rather not run the wizard, copy `.env.example` to `.env.local` and fill in what you have.

Config, env and results are all read and written relative to wherever you run the command, so run it inside your own project.

Pick the arms you actually have keys for:

```bash
sourcery run "<query>" --values firecrawl,tavily
```

The defaults are `bright_data` and `firecrawl`, so with neither of those keys set your first run is a scorecard of failed arms. Honest, but not useful.

### Know what it costs before it spends

Retrieval APIs bill per call and a full batch isn't cheap, so you can price any run first.

```bash
sourcery batch --dry-run           # itemised estimate, spends nothing
sourcery batch --max-credits 400   # refuses to start if the estimate is over your ceiling
```

Fetches are cached for 24 hours, so re-judging something you already retrieved is free, and the estimate subtracts cached arms before it quotes you. Run `providers --check` before anything long. A key being set doesn't mean the account still has quota, and finding that out 200 arms into a two-hour run is expensive.

There's also a `plain` arm that needs no retrieval key at all, just a keyless SERP and a bare `fetch()`. It's there so you can try the tool, not so you can benchmark with it. Keyless search rate-limits hard, and in my testing a block survived 15 minutes of total silence and still didn't lift.

Every run appends to `.sourcery/runs.jsonl`. That file is the contract. The terminal scorecard and the HTML report are both just views over it, and the report shows you every source each provider fetched, the answer built from it, and the judge's reasoning for both scores.

## What's an arm

An arm is one `fetch → answer → judge` pipeline where exactly one thing differs. I took the word from clinical trials and the discipline goes with it. Change one variable, hold everything else still, repeat it enough times to tell signal from noise.

So 480 arms is 48 queries × 2 providers × 5 repeats. It isn't the same search run 400 times, it's 48 different questions fetched five separate times per provider, each fetch graded on its own.

Those repeats are the only reason I trust anything below. Re-running an identical query moves the retrieval score by about a point (`seed_std_mean = 1.04`), and the gap I was trying to measure was 0.22. The effect was five times smaller than the error bar on a single measurement of it. Without repeats you can't know that, and you'll publish the noise.

## What I found

### The gap that wasn't

The most useful thing this eval did was overturn its own first result.

An early pass of 12 queries, one run, one judge, had Bright Data writing better answers than Firecrawl by 2.6 points, and I had a tidy mechanistic story to explain why. So I built the machinery to check whether it was real. Full 48-query set, 5 fresh fetches each, both providers, every arm graded by a two-judge panel. 480 arms, 417 paired verdicts, 95% confidence intervals.

Tested properly the gap vanished.

| | Bright Data | Firecrawl |
|---|---:|---:|
| Retrieval quality (0-10, 95% CI) | 4.78 ± 0.44 | 4.56 ± 0.52 |
| Answer quality (0-10, 95% CI) | 6.55 ± 0.81 | 6.99 ± 0.69 |
| Sources returned per arm | 7.7 | 8.0 |
| Sources extracted | 33% | 90% |
| Median source age | 286 days | 299 days |
| Median latency | 76s | 52s |
| Arm failure rate | 25% | 0.8% |
| Queries with data (of 48) | 46 | 48 |

Answer model (Kimi) held constant across every arm, judges are a two-model open panel (GLM + DeepSeek). Full computed summary is in [`docs/s2-summary.json`](docs/s2-summary.json).

On both quality scores the intervals overlap, so the two providers are statistically indistinguishable and that 2.6-point gap is gone. It was underpowering, not signal.

> An eval's first job is to not fool you. Catching my own earlier conclusion is the whole point of having built one.

Three things do survive the intervals.

**Reliability is the real difference.** Firecrawl failed 2 of 240 arms. Bright Data failed 61 of 240, because its SERP endpoint intermittently returns non-JSON under concurrency, which a retry loop softens but doesn't fix. The two tie on answer quality. They don't tie on returning an answer at all.

**Firecrawl extracts a lot more and it doesn't move quality.** 90% of its sources yield usable text against Bright Data's 33%, which is the one big gap that replicates. It buys no measurable answer-quality edge though (6.99 vs 6.55, overlapping). My earlier story that more extraction produced worse answers was noise. The honest version is that extraction volume and answer quality just aren't connected here.

**Neither is good at freshness.** Every query asks for the latest or current or newest thing, and the median source that comes back is around 290 days old for both. Fresh retrieval is genuinely unsolved, and this measures that rather than asserting it.

There's also a finding about the method itself. The judge moves the score more than the retriever does. Re-running a query shifts the retrieval score by about 1.0, swapping the judge model shifts it by about 2.0, and the two judges only agree at r=0.60. That's why the single-judge result was fragile, and why I'd side-eye any benchmark that grades with one model and prints no interval.

### The answer barely depends on what got retrieved

This is the one I didn't expect, and it's the reason the retrieval score exists at all.

Across 417 paired arms, retrieval score and answer score correlate at **r = 0.16**. Essentially not at all.

A provider can hand back stale, off-topic, half-extracted junk and the answer built on top still scores well, because the answer model is answering from what it already knew rather than from what the retriever found. If you grade a retrieval provider on the quality of the answer downstream of it, you're mostly grading the answer model.

It shows up again on a different set. Six queries across four providers, 72 arms, a different judge setup, gives r = 0.14 once you drop the one arm that failed and was never actually judged. (Leaving that arm in scores it 0.18, but a placeholder 0/0 sitting at the origin drags a positive correlation upward, so 0.14 is the number I'd stand behind. It's also the less flattering one to compute and the more favourable one to my argument, which is worth saying out loud.)

| provider | retrieval (95% CI) | answer (95% CI) |
|---|---:|---:|
| exa | 4.11 ± 1.68 | 8.28 ± 3.76 |
| firecrawl | 3.39 ± 1.44 | 6.11 ± 2.27 |
| bright_data | 2.89 ± 2.39 | 7.06 ± 3.00 |
| tavily | 1.94 ± 1.41 | 8.17 ± 2.47 |

Read the intervals, not the order. Every one of them overlaps every other one. Six queries can't separate four providers, and this table is here as evidence that the decoupling shows up on four different backends, not as a ranking. Rank these providers off this table and you'd be making exactly the mistake the section above is about.

#### One query, all four providers

A correlation coefficient is abstract, so here's what it looks like on a single question anyone can check for themselves.

> What is the current price and storage configurations for the newest iPhone model?

| provider | retrieval | answer |
|---|---:|---:|
| exa | 7 | 0 |
| firecrawl | 3 | 1 |
| bright_data | 1 | 1 |
| tavily | 0 | 9 |

**exa scored 7 on retrieval and 0 on the answer.** It fetched `apple.com/shop/buy-iphone/iphone-17`. The retrieval judge said *"Sources include official Apple store page with price and storage, a current specs database, and recent buying guides, but extraction is truncated and one source is from 2013."* The answer it produced was *"The iPhone 17, Apple's newest standard model, comes in 256GB and 512GB storage configurations (apple.com). The unlocked 256GB model is priced at $829, while the 512GB version costs $1,029 (apple.com)."* The answer judge gave that a zero: *"The answer incorrectly claims the newest iPhone is the unreleased iPhone 17, with storage and price details that are not supported by any current, real sources; it is factually wrong and hallucinated."*

The iPhone 17 shipped in September 2025. This ran in July 2026. Exa fetched the right page, the model answered off it correctly, and the judge marked it wrong because the judge's own world model is a year out of date.

**tavily scored 0 on retrieval and 9 on the answer.** The retrieval judge: *"All sources are either off-topic, empty, or contain only navigation/boilerplate content, providing no relevant information on the newest iPhone's price or storage."* And the answer anyway: *"Apple's newest iPhone lineup includes the iPhone 17 series, with the iPhone 17 Pro Max as the flagship model. The iPhone 17 Pro Max starts at $1,199 for 128GB and rises to $1,999 for 1TB, while the broader 2025 lineup also introduces a 2TB storage tier for the first time (macrumors.com)."* The answer judge: *"The answer accurately cites the iPhone 17 series prices and storage tiers from the provided MacRumors source, but the 'newest' claim may be slightly outdated if a later model exists; all claims are well-grounded."* Nothing usable came back from the fetch, and specific price points came out of the model regardless.

So the same query breaks the answer score in both directions at once. One arm gets punished for a correctly-sourced answer, another gets rewarded for answering out of memory. That's why the retrieval score is the primary metric here and the answer score is secondary, and it's why the default judge is deliberately a stale model.

Two things to be straight about. This query ran three times and I'm showing one repeat, because the single runs are the only records that keep the full answer text (batch rows store the scores and the retrieval reasoning only). The other two repeats are tamer, exa scored 3/3 and 4/0, tavily 0/5 and 1/2. And a reader cloning this repo can't reproduce the table below by running `sourcery report`, because `.sourcery/` is gitignored and no run log ships with the package. Run it against your own keys and you'll get your own version of this.

## Why the scores look low

Mid-4s out of 10 looks like a broken harness. It isn't, and it's worth saying why before you conclude these are bad products.

The dataset is adversarial on purpose. Every one of the 48 queries demands the newest thing that exists, and the median source that comes back is around 290 days old for both providers. That's the result, not a grading bug.

The retrieval score grades the sources, not the answer. Eight results where two are fresh and on topic is a 4, however well the prose downstream reads.

It's single-shot. One query in, eight results, done. No re-query, no follow-up, no reading one page and deciding to go fetch another. That's a deliberate control, it's the only way to isolate the retrieval call, but it isn't how a competent agent actually works and the gap between the two is large.

And the queries aren't representative, which is the next section.

Per category the pattern is the same. Both providers are weakest on `local_geo` (3.84 and 3.67) and `breaking_news` (4.17 and 3.82), strongest on `numeric_live` (5.54 and 5.58) and `how_to` (4.88 and 6.11), Firecrawl first in each pair. Breaking news sitting near the bottom is the uncomfortable one, since it's the category you'd most want a fresh-retrieval product to win. Per-category intervals run ±0.9 to ±1.8 so read that as texture rather than a leaderboard.

## What this dataset isn't

Nobody actually points a retrieval agent at these queries.

The 48 are freshness probes, things like "what is the latest major development in the ongoing Russia-Ukraine war" and "what is the current stock price of NVIDIA". Phrasing them that way was a deliberate call for durability. Nothing is pinned to a version or a date, so the set doesn't rot and it's still valid next year. But I bought that durability with realism. Real retrieval work looks more like finding the open backend roles at a company with their comp bands, or the price and storage options for a product on a particular store, or the current per-token pricing tiers for a model, or which of these 30 companies have raised since January.

Those are jobs with a right answer sitting on a specific page, and they're what you'd actually build a research agent for. The 48 are none of that. So part of why the scores are low is that the questions are both hard and unrepresentative, and someone who sees 4.5/10 and concludes the providers are broken has been misled by my dataset design rather than informed by it.

The fix is additive, not a rewrite. A second dataset of real retrieval tasks, selectable by flag and reported separately, with `core/eval-dataset.ts` left exactly as it is. The 480-arm result is anchored to those 48 queries and quietly editing them would invalidate the headline rather than improve it. Two datasets that disagree is a more interesting result than either on its own.

That work isn't done yet. This section is the caveat until it is.

## What I'd defend, and what I wouldn't

An eval you can't trust is worse than no eval.

I'd defend the reliability gap (25% against 0.8% over 240 arms each is not noise), the extraction gap (90% against 33%), the shared freshness weakness (~290-day median across 46 to 48 queries and both judges), that judge choice dominates re-run noise, and the retrieval/answer decoupling, which holds at r=0.16 over 417 arms and reproduces on a separate four-provider set.

I wouldn't defend any claim that one provider retrieves better than another. Every confidence interval overlaps, in both tables, full stop. Nor any per-category ranking off the four-provider runs, since six queries and three repeats is an illustration and not a measurement. Bright Data's 25% failure rate is also measured under this harness at concurrency 6, and a gentler caller will see fewer, even though the bad-proxy-exit mechanism behind it is real.

I'd hold the absolute score levels loosely. They're a property of how hard this dataset is, and the section above explains why that difficulty is unrepresentative.

The old caveat this section used to carry, "n=12, single run, one judge, no CIs", is closed. It got replaced by 480 arms, a two-judge panel and intervals, which then reversed the headline it had been hedging.

One more thing on neutrality. The 480-arm comparison is Bright Data against Firecrawl because those were the only two keys I had when I ran it, not because they're the two that matter. Tavily and Exa got keyed later and are measured on the smaller set. If you want a different pairing the whole point is that you can go run it yourself.

## Providers

Five retrieval arms ship in the box.

| id | Status | Keys needed | Shape |
|---|---|---|---|
| `bright_data` | measured, 240 arms | 3 (token + 2 zone names) | Google SERP, then a separate unblocked fetch per URL |
| `firecrawl` | measured, 240 arms | 1 | search and scrape in one call |
| `tavily` | measured, 18 arms | 1 | RAG-tuned index, optional raw page content |
| `exa` | measured, 18 arms | 1 | neural index, the only arm with reliable native publish dates |
| `plain` | baseline only | none | keyless SERP and a bare `fetch()`, the free baseline |

The arm counts are the point of that status column. 240 arms supports a confidence interval, 18 supports an anecdote, and both are labelled so you know which one you're reading.

An adapter is one function, `(query, config) => { sources, context }`, plus a row in the registry. That's the entire interface and it's about 40 lines for a typical JSON search API. Setup recipes, per-provider quirks, credit arithmetic and a full worked example are in [`docs/providers.md`](docs/providers.md).

### What an arm actually costs

Running this produced an incidental result about Firecrawl's billing that's worth writing down, because the published per-call pricing doesn't obviously predict it.

I'd assumed 10 credits per arm. It's 20. Three controlled `/v2/search` calls at `limit: 8`, diffing `remainingCredits` between them, isolate where it goes.

| request | credits | what it isolates |
|---|---:|---|
| `sources: ["web"]`, no scrape | 2 | search on its own |
| `sources: ["web"]` + markdown | 10 | +8, so 1 credit per page scraped |
| `sources: ["web","news"]` + markdown | 20 | +10, so a second search *and* 8 more scrapes |

Asking for two source types buys two searches and two sets of scrapes. Real arms bill 20 to 65, going higher when Firecrawl escalates to a browser rendering path, and government statistics pages were consistently the worst. That's the difference between a 48-query batch costing 1,000 credits and costing 5,000, which is why `--dry-run` exists. The method and the levers that bring it down are in [`docs/providers.md`](docs/providers.md).

## Use it from an agent

sourcery ships an MCP server on the same binary, so the eval is something an agent can consult rather than something a human reads afterwards. Two tools:

| tool | cost | what it does |
|---|---|---|
| `which_provider` | one LLM call, no retrieval | Classifies a query into one of the six types and returns whichever provider scored best on that type in the eval history. Use it to pick a backend. |
| `evaluate_retrieval` | slow, metered, live provider and LLM calls | Runs one query across several providers with everything else held constant and returns per-provider scores. Use it to prove one. |

The cheap one is the useful pattern. Before an agent spends a retrieval call it can ask which backend has actually done best on this kind of question and route accordingly, which is evidence instead of a hardcoded default for the price of a single classification. `which_provider` falls back to the shipped 480-arm summary when there's no local run history, so it works on a fresh install.

```bash
sourcery mcp    # stdio MCP server
```

Tool definitions live in [`mcp/server.ts`](mcp/server.ts).

## Bring your own model

The retrieval provider is the variable. The model is yours to pick.

The answer step and both judges go through one provider-agnostic seam, so you can point the whole eval at any OpenAI-compatible backend including something running on your own hardware. A model is a `provider/model` ref, and a bare id like `gpt-4o-mini` means OpenAI.

```bash
# OpenAI, needs OPENAI_API_KEY
sourcery run "<query>" --model gpt-4o-mini

# Fireworks, needs FIREWORKS_API_KEY, and it's what init scaffolds by default
sourcery run "<query>" \
  --model fireworks/accounts/fireworks/models/kimi-k2p6 \
  --judge fireworks/accounts/fireworks/models/deepseek-v4-pro
```

This matters more than it looks. An eval of your retrieval stack is only meaningful if it runs the model you actually ship, and "which model is best" is a question this tool deliberately won't answer for you. You only need a key for the backend you actually use, and adding another OpenAI-compatible one (Together, Groq, vLLM) is a single row in [`core/llm/`](core/llm/).

The judge defaults to a stale model on purpose. The anti-cheat needs the judge's cutoff to predate the queries, so a fresher judge only affects the answer score and never the primary retrieval score. The iPhone example above is what that tradeoff looks like when it bites.

## Stack

TypeScript, a Commander CLI over a framework-free [`core/`](core/), an MCP server on the same binary, and retrieval adapters in [`core/adapters/`](core/adapters/).

MIT © [Sameer Himati](https://sameerhimati.com).
