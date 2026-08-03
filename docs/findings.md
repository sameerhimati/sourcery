# What I found when I ran it

These are results from my own runs of the harness on its built-in query set. They are here as evidence that the thing works and that the question is not trivial, not as an answer you should adopt. Your queries are not these queries, which is the entire argument for running it yourself.

Back to the [README](../README.md).

## The answer barely depends on what got retrieved

This is the one I didn't expect, and it's the reason there are two scores instead of one.

Across the full set, how good the sources were and how good the answer was correlate at **r = 0.16**. Essentially not at all.

A provider can hand back stale, off-topic, half-extracted junk and the answer built on top still scores well, because the answer model is answering from what it already knew rather than from what the retriever found. If you grade a retrieval provider on the quality of the answer downstream of it, you're mostly grading the answer model.

It shows up again on a separate pass across all four keyed providers, at r = 0.14 once you drop the one call that failed and was never actually judged. (Leaving it in scores 0.18, but a placeholder 0/0 sitting at the origin drags a positive correlation upward, so 0.14 is the number I'd stand behind. It's the less flattering one to compute and the more favourable one to my argument, which is worth saying out loud.)

| provider | source quality (95% CI) | answer quality (95% CI) |
|---|---:|---:|
| exa | 4.11 ± 1.68 | 8.28 ± 3.76 |
| firecrawl | 3.39 ± 1.44 | 6.11 ± 2.27 |
| bright_data | 2.89 ± 2.39 | 7.06 ± 3.00 |
| tavily | 1.94 ± 1.41 | 8.17 ± 2.47 |

Read the intervals, not the order. Every one of them overlaps every other one. That's six queries and three fetches each, which is an illustration that the decoupling shows up on four different backends, not a measurement of which backend is better. Rank these providers off this table and you'd be making exactly the mistake the rest of this section is about.

### One query, all four providers

A correlation coefficient is abstract, so here's what it looks like on a single question anyone can check for themselves.

> What is the current price and storage configurations for the newest iPhone model?

| provider | sources | answer |
|---|---:|---:|
| exa | 7 | 0 |
| firecrawl | 3 | 1 |
| bright_data | 1 | 1 |
| tavily | 0 | 9 |

**exa scored 7 on sources and 0 on the answer.** It fetched `apple.com/shop/buy-iphone/iphone-17`. The retrieval judge said *"Sources include official Apple store page with price and storage, a current specs database, and recent buying guides, but extraction is truncated and one source is from 2013."* The answer it produced was *"The iPhone 17, Apple's newest standard model, comes in 256GB and 512GB storage configurations (apple.com). The unlocked 256GB model is priced at $829, while the 512GB version costs $1,029 (apple.com)."* The answer judge gave that a zero: *"The answer incorrectly claims the newest iPhone is the unreleased iPhone 17, with storage and price details that are not supported by any current, real sources; it is factually wrong and hallucinated."*

The iPhone 17 shipped in September 2025. This ran in July 2026. Exa fetched the right page, the model answered off it correctly, and the judge marked it wrong because the judge's own world model is a year out of date.

**tavily scored 0 on sources and 9 on the answer.** The retrieval judge: *"All sources are either off-topic, empty, or contain only navigation/boilerplate content, providing no relevant information on the newest iPhone's price or storage."* And the answer anyway: *"Apple's newest iPhone lineup includes the iPhone 17 series, with the iPhone 17 Pro Max as the flagship model. The iPhone 17 Pro Max starts at $1,199 for 128GB and rises to $1,999 for 1TB, while the broader 2025 lineup also introduces a 2TB storage tier for the first time (macrumors.com)."* The answer judge: *"The answer accurately cites the iPhone 17 series prices and storage tiers from the provided MacRumors source, but the 'newest' claim may be slightly outdated if a later model exists; all claims are well-grounded."* Nothing usable came back from the fetch, and specific price points came out of the model regardless.

So the same query breaks the answer score in both directions at once. One provider gets punished for a correctly-sourced answer, another gets rewarded for answering out of memory. That's why source quality is the primary metric here and answer quality is secondary, and it's why the default judge is deliberately a stale model.

Two things to be straight about. This query ran three times and I'm showing one, because single runs are the only records that keep the full answer text (batch rows store the scores and the source reasoning only). The other two are tamer, exa scored 3/3 and 4/0, tavily 0/5 and 1/2. And cloning this repo won't reproduce these tables by running `sourcery report`, because `.sourcery/` is gitignored and no run log ships with the package. Run it against your own keys and you'll get your own version.

## The gap that wasn't

The most useful thing this eval did was overturn its own first result.

An early pass of 12 queries, one fetch each, one judge, had Bright Data writing better answers than Firecrawl by 2.6 points, and I had a tidy mechanistic story to explain why. So I built the machinery to check whether it was real: the full 48 queries, five fresh fetches each, both providers, everything graded by two judge models instead of one.

Tested properly the gap vanished.

| | Bright Data | Firecrawl |
|---|---:|---:|
| Source quality (0-10, 95% CI) | 4.78 ± 0.44 | 4.56 ± 0.52 |
| Answer quality (0-10, 95% CI) | 6.55 ± 0.81 | 6.99 ± 0.69 |
| Sources returned per call | 7.7 | 8.0 |
| Sources extracted | 33% | 90% |
| Median source age | 286 days | 299 days |
| Median latency | 76s | 52s |
| Failed calls | 25% | 0.8% |
| Queries with data (of 48) | 46 | 48 |

Answer model (Kimi) held constant throughout, judges a two-model open panel (GLM + DeepSeek). Full computed summary in [`docs/s2-summary.json`](docs/s2-summary.json).

On both quality scores the intervals overlap, so the two are statistically indistinguishable and that 2.6-point gap is gone. It was underpowering, not signal.

> An eval's first job is to not fool you. Catching my own earlier conclusion is the whole point of having built one.

Those repeats are the only reason I trust any of this. Asking the same provider the same question twice moves its source score by about a point, and the gap I was chasing was 0.22. The effect was five times smaller than the error bar on a single measurement of it. Without repeats you can't know that, and you'll publish the noise.

Three things do survive the intervals.

**Reliability is the real difference.** Firecrawl failed 2 calls in 240. Bright Data failed 61, because its SERP endpoint intermittently returns non-JSON under concurrency, which a retry loop softens but doesn't fix. The two tie on answer quality. They don't tie on returning an answer at all.

**Firecrawl extracts a lot more and it doesn't move quality.** 90% of its sources yield usable text against Bright Data's 33%, which is the one big gap that replicates. It buys no measurable answer-quality edge though (6.99 vs 6.55, overlapping). My earlier story that more extraction produced worse answers was noise. The honest version is that extraction volume and answer quality just aren't connected here.

**Neither is good at freshness.** Every query in the set asks for the latest or current or newest thing, and the median source that comes back is around 290 days old for both. Fresh retrieval is genuinely unsolved, and this measures that rather than asserting it.

There's also a finding about the method itself. The judge moves the score more than the retriever does. Re-running a query shifts the source score by about 1.0, swapping the judge model shifts it by about 2.0, and the two judges only agree at r=0.60. That's why the single-judge result was fragile, and why I'd side-eye any benchmark that grades with one model and prints no interval.

## Why the scores look low

Mid-4s out of 10 looks like a broken harness. It isn't, and it's worth saying why before you conclude these are bad products.

The built-in dataset is adversarial on purpose. Every one of its 48 queries demands the newest thing that exists, and the median source that comes back is around 290 days old. That's the result, not a grading bug.

The source score grades what came back, not the prose downstream. Eight results where two are fresh and on topic is a 4, however well the answer reads.

It's single-shot. One query in, eight results, done. No re-query, no follow-up, no reading one page and deciding to go fetch another. That's a deliberate control, it's the only way to isolate the retrieval call, but it isn't how a competent agent actually works and the gap between the two is large.

And the queries aren't representative, which is the next section.

Per category the pattern is the same. Both providers are weakest on `local_geo` (3.84 and 3.67) and `breaking_news` (4.17 and 3.82), strongest on `numeric_live` (5.54 and 5.58) and `how_to` (4.88 and 6.11), Firecrawl first in each pair. Breaking news sitting near the bottom is the uncomfortable one, since it's the category you'd most want a fresh-retrieval product to win. Per-category intervals run ±0.9 to ±1.8 so read that as texture rather than a leaderboard.

## What the built-in dataset isn't

Nobody actually points a retrieval agent at these queries.

The 48 are freshness probes, things like "what is the latest major development in the ongoing Russia-Ukraine war" and "what is the current stock price of NVIDIA". Phrasing them that way was a deliberate call for durability. Nothing is pinned to a version or a date, so the set doesn't rot and it's still valid next year. But I bought that durability with realism. Real retrieval work looks more like finding the open backend roles at a company with their comp bands, or the price and storage options for a product on a particular store, or the current per-token pricing tiers for a model, or which of these 30 companies have raised since January.

Those are jobs with a right answer sitting on a specific page, and they're what you'd actually build a research agent for. The 48 are none of that. So part of why the scores are low is that the questions are both hard and unrepresentative, and someone who sees 4.5/10 and concludes the providers are broken has been misled by my dataset design rather than informed by it.

This is also the strongest argument for running it on your own queries rather than reading mine. Your queries are the ones you care about, and they're nothing like these.

The fix on my side is additive, not a rewrite. A second dataset of real retrieval tasks, selectable by flag and reported separately, with `core/eval-dataset.ts` left exactly as it is. The published numbers are anchored to those 48 queries and quietly editing them would invalidate the result rather than improve it. Two datasets that disagree is a more interesting finding than either on its own.

That work isn't done yet. This section is the caveat until it is.

## What I'd defend, and what I wouldn't

An eval you can't trust is worse than no eval.

I'd defend the reliability gap (25% against 0.8% over 240 calls each is not noise), the extraction gap (90% against 33%), the shared freshness weakness (~290-day median across both providers and both judges), that judge choice dominates re-run noise, and the retrieval/answer decoupling, which holds at r=0.16 on the full set and reproduces on a separate four-provider pass.

I wouldn't defend any claim that one provider retrieves better than another. Every confidence interval overlaps, in both tables, full stop. Nor any per-category ranking off the four-provider pass, since six queries and three fetches is an illustration and not a measurement. Bright Data's 25% failure rate is also measured under this harness at concurrency 6, and a gentler caller will see fewer, even though the bad-proxy-exit mechanism behind it is real.

I'd hold the absolute score levels loosely. They're a property of how hard this dataset is, and the section above explains why that difficulty is unrepresentative.

And the comparison that got the full treatment is Bright Data against Firecrawl because those were the only two keys I had when I ran it, not because they're the two that matter. Tavily and Exa got keyed later. If you want a different pairing, that's the tool.


