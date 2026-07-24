# The web-retrieval landscape, and where this eval sits

Notes on the industry sourcery measures: what the primitives actually are, who
sells what, and how the existing benchmarks are built. Written to be able to
answer "what do you understand about this space" without hand-waving.

---

## The two primitives: SERP vs Web Unlocker

These solve different problems and it's worth being precise, because the whole
industry is built on the split.

**SERP API — discovery.** Send a query, get a search engine's results page
parsed into JSON: titles, URLs, snippets, ranking. You are paying someone to run
searches at scale without being blocked, because search engines aggressively
rate-limit automation. You get back **pointers**, not content.

**Web Unlocker — retrieval.** Send a URL, get that page's content. The job is
defeating everything between you and the page: bot detection, CAPTCHAs, IP
reputation, TLS fingerprinting, JS-only rendering, geo-walls. Residential IP
rotation, real browser fingerprints.

Discovery tells you *where*; retrieval gets you *what*. The `bright_data` arm
chains them — one SERP call, then N Unlocker calls — which is why it's the
slowest arm and why extraction dominates its cost.

The `plain` adapter demonstrates the value of the second one by lacking it: a
keyless SERP blocks after ~10 queries and the block outlasts 15 minutes of
silence (measured, 2026-07-24). That block **is** the product. Unlocker is
somebody selling you its absence.

---

## The layers

**1. Proxy & unblocking infrastructure** — Bright Data, Oxylabs, Zyte,
Smartproxy. Residential IP pools, browser farms, CAPTCHA solving.
Capital-intensive, enterprise sales, compliance-heavy. **Bright Data lives
here** — it sells pipes. Its SERP API and Web Unlocker are products layered on a
proxy network that took years to build; that's a moat you don't out-spend
quickly.

**2. SERP-as-JSON** — SerpAPI, Serper, ScrapingDog, Bright Data SERP. Thin,
fast, cheap, commoditized. Competition is price and latency.

**3. Agent/RAG-shaped APIs** — **Firecrawl**, Tavily. The newer layer, and where
the product thinking is. They don't try to out-proxy layer 1. They compete on
**output shape and ergonomics**: one call returns clean markdown ready to chunk
and embed. Firecrawl's verbs — search, scrape, map, crawl, interact — are a
vocabulary for "give my agent the web."

**4. Own-index search** — Exa, Brave. A different bet: don't proxy Google, build
your own index. Exa searches by embedding similarity, so it's strong on "find
things semantically like this" and reports real publish dates; its coverage
shape on breaking news differs from Google's.

**5. Model providers** — retrieval bundled into the model. See below.

---

## What Google uses vs sells

Google *is* the index — its own crawl, its own infrastructure. It buys none of
this.

What it *sells* developers is narrow: a heavily-limited Custom Search JSON API,
and Grounding with Google Search in the Gemini API. And it **restricts automated
SERP scraping** — which is the structural reason layers 1 and 2 exist at all.
The SERP-API business is an arbitrage on Google not selling its results
directly.

---

## Model providers' built-in search

All the majors now ship retrieval inside the model: Google (Grounding with
Google Search), OpenAI (web search tool), Anthropic (web search + web fetch
tools), Perplexity (Sonar).

This looks like it commoditizes layers 1–4. It mostly doesn't, for two reasons:
**no control** (you can't pick the index, tune freshness, or swap providers) and
**no visibility** (you can't see or score what was retrieved).

Evidence that the choice matters: running the *same query* through all three on
the same day produces materially different grounding behaviour — OpenAI pulling
~39 pages and citing 2, Anthropic surfacing the richest considered-set, Google
retrieving few and citing nearly all behind redirect URLs
(<https://dejan.ai/blog/grounding/>).

That is this project's thesis, on a layer this eval doesn't yet cover. It is
also the larger audience: far more developers use OpenAI's search tool than have
ever configured a Web Unlocker zone.

---

## Firecrawl's four verbs

| Verb | What it does | Cost shape |
|---|---|---|
| `search` | query → ranked results, optionally scraped inline | 2 credits / 10 results |
| `scrape` | URL → clean markdown / JSON / screenshot | 1 credit / page |
| `map` | site → all its URLs, fast | **1 credit flat** |
| `crawl` | site → every page's content | per page |
| `interact` | drive a browser on a scraped page | 2 credits/min (code), 7 (AI prompts) |

`map` is sitemap-first, supplemented by cached crawl and search results, and
explicitly trades completeness for speed ("may not capture all website links").
It takes a `search` param that ranks discovered URLs by relevance. `crawl` is
the thorough, slower counterpart.

`interact` is a browser session — click, fill forms, paginate, log in — billed
per session-minute rather than per page, with state persisting across calls.

Firecrawl also ships an **MCP server** (`npx firecrawl-mcp`). That's a
distribution move, not a new capability: it exposes the same verbs to any agent
that speaks the Model Context Protocol, no SDK wiring. It's how these providers
get *inside* agent runtimes rather than sitting behind a REST call — and it's a
channel sourcery could plausibly expose too, so an agent can run an eval on its
own retrieval from inside its own loop.

**None of this is unique to Firecrawl.** Tavily also ships `/map` and `/crawl`,
but with a different design: parallel graph traversal with `max_depth` /
`max_breadth` / `limit` and natural-language `instructions` to steer it, billed
1 credit per 10 pages. So one reads the sitemap fast, the other walks the graph.
Exa has no general map/crawl. The search-only APIs (Serper, Brave, SerpAPI) have
neither.

That difference in *kind* is what makes map/crawl evaluable — see below.

---

## How the existing benchmarks are built

### Firecrawl's SimpleQA eval

Firecrawl publishes agents using its `/search` scoring **94.7%** on SimpleQA,
above Exa (91.9%), Parallel (91.0%), and Claude Native (90.5%).

Their stated methodology: a GPT-5.4 agent at high reasoning effort, up to 20
tool calls, with `search_web` backed by the provider under test and `web_fetch`
through that provider's own extract API. Graded by GPT-5.4 with the official
SimpleQA grader prompt, across all 4,326 questions, **two sessions per provider
with the best observed score selected**. No-search baseline: 43.8%.

**What it measures.** SimpleQA is short fact-seeking questions with single
verified answers — obscure but *static* facts. The 43.8% baseline says the model
already knows nearly half of them unaided. So the benchmark asks whether
retrieval can surface a **fixed fact the model half-remembers**. It's a lookup
task, and it says essentially nothing about freshness.

**Four properties worth understanding** (not errors — they define the space):

1. **Best-of-2 selection is upward-biased**, and concedes that run-to-run
   variance exists without reporting it.
2. **No confidence intervals**, on a chart where all four providers land within
   **4.2 points**. Hard to separate signal from selection.
3. **The Claude Native arm varies two things** — Sonnet 4.6 *and* Anthropic
   search, vs GPT-5.4 everywhere else. Labelled honestly as a whole-system
   comparison, but it means 90.5% isn't a statement about Claude's retrieval.
4. **20 tool calls** measures the whole agentic loop, where a persistent agent
   compensates for mediocre retrieval by searching again. This eval isolates a
   single retrieval call.

**The strategic read:** four providers inside four points means the benchmark
has largely stopped discriminating. It's saturated.

### Where this eval is different

| | SimpleQA-style | sourcery |
|---|---|---|
| Question type | static, curated facts | fresh info, "latest / current" |
| Ground truth | yes — objective grading | none — LLM judge required |
| Scale | 4,326 questions | 48 queries × seeds |
| Variance reported | no (best-of-2) | 95% CIs, seed vs judge decomposition |
| Scores | whole agent loop | the retrieval call itself |
| Vendor | published by a vendor about itself | independent |

The trade is real and runs both ways. Ground truth is a genuine strength of
SimpleQA that this eval lacks — the cost is LLM judges, whose disagreement was
measured at r=0.65 (mean |Δ| 1.64) on a 12-arm validation run. The compensating
strength is that **freshness is the thing nobody benchmarks**, because it has no
static answer key — and it is where retrieval visibly fails.

---

## The idea worth building next: time-anchored ground truth

There is a way to get SimpleQA's objectivity *without* abandoning freshness.

A static answer key is impossible for "what is the current X" — but a
**runtime-verifiable** one is not. Current Node LTS version, current
officeholder, latest release tag, current price: all fetchable from an
authoritative source at eval time.

Pin a subset of the eval set to those authorities and that subset can be
**auto-graded — no LLM judge, no judge disagreement** — while still testing
freshness. That repairs the weakest joint in this methodology (judge noise)
using the one property that makes SimpleQA strong, without inheriting its
blindness to recency.

It is also a better answer to "make the queries more realistic" than
hand-writing more of them, and it composes with the longer-term direction
already in the plan: **the eval set should ultimately be your own traffic.**

## The other extension: evaluating map/crawl

The same methodology points at URL discovery, and that version has a property
the current eval lacks: **ground truth**. "Did it find the right URLs" is
checkable against a known sitemap — precision, recall, coverage-at-depth,
time-to-first-URL. No judge, no anti-cheat design needed.

Firecrawl's `map` is 1 credit flat, so it is also cheap to evaluate. Firecrawl
(sitemap-first, speed) and Tavily (graph traversal, steerable) differ enough in
approach that they should score differently on coverage vs latency.
