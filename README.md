# sourcery

**A retrieval-eval harness for web-search APIs.** Same query, same answer model, same judge — swap only the retrieval provider, and measure what actually changes.

Built to answer a question I couldn't find a straight answer to: *if you're building a RAG or research agent on top of a web-retrieval API, does the provider you pick actually matter — and how would you know?*

---

## The finding

12 retrieval-dependent queries through both providers. Single run, `gpt-4o-mini` as judge, scores 0–10.

| | Bright Data | Firecrawl |
|---|---:|---:|
| **Answer quality** | **6.6** | 4.0 |
| Retrieval quality | 4.1 | 3.7 |
| Sources returned | 7.5 | 7.3 |
| **Sources successfully extracted** | 2.1 | **6.3** |
| Median source age | 339 days | 381 days |
| Latency (median) | 22.0s | 12.4s |

**Firecrawl extracts 3× more content and produces worse answers.**

That's the result worth sitting with. Both providers *find* about the same number of sources — 7.5 vs 7.3. The difference is what happens next: Firecrawl successfully pulls text out of six of them, Bright Data manages two. And the pipeline handed **less** content wrote the better answer, by 2.6 points.

More context, worse output. Whatever the answer model is doing with those extra four documents, it isn't helping.

**Second finding, and maybe the more useful one:** every query in the set explicitly asks for the *latest* / *current* / *newest* thing. Both providers return sources with a median age of roughly **a year**. If you're building on web retrieval and assuming you get fresh documents — measure it. You probably don't.

---

## Why the eval is built this way

The design problem with judging retrieval is that **the judge can cheat.** Ask a model to score an answer on a topic it already knows, and it will happily reward a response that came from parametric memory rather than from anything the retriever actually fetched. You end up measuring the answer model, not the retriever.

So the dataset is built to make that impossible:

- **The judge is stale on purpose.** `gpt-4o-mini` has an Oct-2023 cutoff; the harness runs with a reference date of 2026-07-07. Anything answerable from memory alone is, by construction, out of date.
- **Every query demands fresh information** — 6 categories × 8 queries: `breaking_news`, `how_to`, `product_lookup`, `local_geo`, `recent_release`, `numeric_live`.
- **Queries are phrased as "latest / current / newest," never pinned to a version, date, or figure** — so the dataset doesn't rot as the world moves. It's still a valid eval next year.

Two separate scores, because retrieval and answering fail differently: `retrieval_score` grades the *sources* (fresh? relevant? real?), `answer_score` grades the *answer built from them*. A run can retrieve well and answer badly, and you want to see which half broke.

Dataset and reasoning: [`core/eval-dataset.ts`](core/eval-dataset.ts) · Scoring: [`core/judge.ts`](core/judge.ts), [`core/retrievalJudge.ts`](core/retrievalJudge.ts)

---

## What I'd defend, and what I wouldn't

An eval you can't trust is worse than no eval, so:

- **n = 12 per arm, single run, one judge model.** Enough to see a 2.6-point gap. Not enough to crown a winner, and not enough for a confidence interval worth printing.
- No inter-judge agreement check.
- **The extraction-vs-quality inversion is the result I'd actually defend** — it's large, mechanistically explainable, and points at a real question. Everything else here is directional.

Next run: the full 48 queries, three seeds, a second judge.

---

## Run it

```bash
npm install
sourcery run "what's the latest macbook pro" --values plain,firecrawl
```

That first command needs **no retrieval API key at all** — the `plain` arm is a keyless SERP with a bare `fetch()`, there so you can see the thing work before signing up for anything. You still need one LLM key for the answer and judge steps.

```bash
sourcery init                        # scaffold .sourcery.json + .env.example
sourcery providers                   # what's registered, what keys you're missing
sourcery run "<query>"               # one query, arms side by side
sourcery batch                       # the full 48-query eval set → per-query heatmap
sourcery report                      # self-contained HTML from the run log
```

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

`plain` deserves one caveat up front: keyless search blocks sustained automated use, so it's for trying the tool, not for benchmarking. That unreliability is itself informative — availability under load is a large part of what a paid provider sells.

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

TypeScript · a Commander CLI over a framework-free [`core/`](core/) · Next.js dashboard · retrieval adapters in [`core/adapters/`](core/adapters/)

---

Built by [Sameer Himati](https://sameerhimati.com).
