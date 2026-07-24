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

Dataset and reasoning: [`src/lib/eval-dataset.ts`](src/lib/eval-dataset.ts) · Scoring: [`src/lib/judge.ts`](src/lib/judge.ts), [`src/lib/retrievalJudge.ts`](src/lib/retrievalJudge.ts)

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
cp .env.example .env    # OPENAI_API_KEY, BRIGHT_DATA_API_KEY, FIRECRAWL_API_KEY
npm run dev
```

Single query through both arms, or a batch across the eval set. Results render as a per-query heatmap, so you can see *which* query types each provider fails on. Both collapse on `breaking_news` (2.5 / 2.5) — the category you'd most want them to be good at.

## Models

The answer step and both judges run through one provider-agnostic seam, so you can point them at any OpenAI-compatible backend. A model is a `provider/model` ref; a bare id (`gpt-4o-mini`) means OpenAI.

```bash
# OpenAI (needs OPENAI_API_KEY)
sourcery run "<query>" --model gpt-4o-mini

# Fireworks (needs FIREWORKS_API_KEY) — the scaffolded default from `sourcery init`
sourcery run "<query>" \
  --model fireworks/accounts/fireworks/models/kimi-k2p6 \
  --judge fireworks/accounts/fireworks/models/deepseek-v4-pro
```

You only need the LLM key for the provider you actually use — `run`/`batch` require exactly that one. Adding another OpenAI-compatible provider (Together, Groq, vLLM, …) is one row in `core/llm/`. The judge defaults to a stale model on purpose: the anti-cheat needs its cutoff to predate the queries, so a fresh judge only affects `answer_score`, never the primary `retrieval_score`.

## Stack

Next.js · TypeScript · OpenAI API · Bright Data + Firecrawl adapters ([`src/lib/adapters/`](src/lib/adapters/))

---

Built by [Sameer Himati](https://sameerhimati.com).
