# sourcery

**A retrieval-eval harness for web-search APIs.** Same query, same answer model, same judge — swap only the retrieval provider, and measure what actually changes.

Built to answer a question I couldn't find a straight answer to: *if you're building a RAG or research agent on top of a web-retrieval API, does the provider you pick actually matter — and how would you know?*

---

## The finding

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

---

## Why the eval is built this way

The design problem with judging retrieval is that **the judge can cheat.** Ask a model to score an answer on a topic it already knows, and it will happily reward a response that came from parametric memory rather than from anything the retriever actually fetched. You end up measuring the answer model, not the retriever.

So the dataset is built to make that impossible:

- **The primary metric can't be answered from memory.** `retrieval_score` grades the *fetched sources* — fresh? on-topic? real? — not the answer, so a judge can't reward what it already knew instead of what the retriever found. (The default single-judge run also uses a stale model, `gpt-4o-mini`, Oct-2023 cutoff against a 2026 reference date, which protects the secondary `answer_score`; the credibility run swaps in a current-model panel because measuring inter-judge agreement needs capable judges.)
- **Every query demands fresh information** — 6 categories × 8 queries: `breaking_news`, `how_to`, `product_lookup`, `local_geo`, `recent_release`, `numeric_live`.
- **Queries are phrased as "latest / current / newest," never pinned to a version, date, or figure** — so the dataset doesn't rot as the world moves. It's still a valid eval next year.

Two separate scores, because retrieval and answering fail differently: `retrieval_score` grades the *sources* (fresh? relevant? real?), `answer_score` grades the *answer built from them*. A run can retrieve well and answer badly, and you want to see which half broke.

Dataset and reasoning: [`core/eval-dataset.ts`](core/eval-dataset.ts) · Scoring: [`core/judge.ts`](core/judge.ts), [`core/retrievalJudge.ts`](core/retrievalJudge.ts)

---

## What I'd defend, and what I wouldn't

An eval you can't trust is worse than no eval.

- **I'd defend:** the reliability gap (25% vs 0.8% over 240 arms each is not noise), the extraction gap (90% vs 33%), the shared freshness weakness (~290-day median across 46–48 queries and both judges), and that judge choice dominates re-run noise.
- **I wouldn't defend:** any claim that one provider retrieves *better* — the confidence intervals overlap, full stop. And Bright Data's 25% failure rate is measured under this harness at concurrency 6; a gentler caller sees fewer, even though the bad-proxy-exit mechanism is real.
- **Now closed:** the old "n=12, single run, one judge, no CIs" caveat this section used to carry. It's been replaced by 480 arms, a two-judge panel, and intervals — which, usefully, reversed the headline it was hedging.

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

The batch heatmap is the useful one: it shows *which query types* a provider fails on rather than a single average. Both providers collapse on `breaking_news` (2.5 / 2.5) — the category you'd most want them to be good at.

## Providers

Five retrieval arms ship in the box:

| id | Keys needed | Shape |
|---|---|---|
| `bright_data` | 3 (token + 2 zone names) | Google SERP, then a separate unblocked fetch per URL |
| `firecrawl` | 1 | search + scrape in one call |
| `tavily` | 1 | RAG-tuned index, optional raw page content |
| `exa` | 1 | neural index; the only arm with reliable native publish dates |
| `plain` | **none** | keyless SERP + bare `fetch()` — the free baseline |

An adapter is one function — `(query, config) => { sources, context }` — plus a row in the registry. That's the whole interface, and it's about 40 lines for a typical JSON search API. Setup recipes, per-provider quirks, credit arithmetic, and a complete worked example: **[`docs/providers.md`](docs/providers.md)**.

`plain` deserves one caveat up front: keyless search blocks sustained automated use — measured here, a block survived 15 minutes of complete silence and did not lift. So it's for trying the tool, not for benchmarking. That unreliability is itself informative: availability under automated load is a large part of what a paid provider sells.

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
