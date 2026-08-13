# Who gets measured, and why

Sourcery has measured four search providers: Firecrawl, Exa, Tavily and Bright
Data. **Nothing chose them.** They are the four somebody wrote an adapter for.

That was fine while nobody was reading. It stops being fine for run 2, which
answers a question raised by an engineer at Exa, partly paid for in Exa credits,
in a benchmark Exa currently wins. *Why isn't X in here* and *you left out the one
that beats you* both need an answer anyone can check, and "these are the ones I
built" is not one.

---

## The rule

> **Measured:** providers with real standing in the market this benchmark is
> about — retrieval sold to people building AI agents. Each one below records
> which specific evidence put it there.
>
> **Also measured:** anyone who asks. Open an issue. The bar is the technical one
> — a web-search API anyone can sign up for, at a price published on a public
> page — and requests are public, so a refusal is visible too.

The second clause is doing most of the work. An eval is only worth reading if the
question set is good, and building sixteen adapters for providers nobody uses buys
width instead of quality. **"Nobody asked" is a complete and checkable answer to
why a provider isn't here**, and it costs a vendor who wants in exactly one issue.

### Why not "everyone with a public API"

That was the first version of this rule and it was worse. It admitted twenty
providers, most of which no agent builder has heard of, and then averaged across
them — so a headline number would have been partly an average over vendors with
no users. Width is not neutrality.

### Why not "biggest company"

**There is no published market share for search APIs.** Consumer search share
(Google ~90%) is a different market and says nothing about who sells retrieval to
agent builders.

Revenue doesn't substitute either. **Oxylabs is valued at $3.6B — more than Exa —
and appears as a first-class integration in zero agent frameworks.** It's a proxy
and scraping business. Big company, not big in this market. The same goes for
Apify, ZenRows, Scrapfly and ScrapingBee, which Oxylabs acquired in 2025.

---

## The evidence that counts

Four signals, in the order I'd trust them. A provider is in if it clears at least
one, and the table below says which.

1. **Named as the search backend of a major AI product.** The strongest signal
   there is — real production volume at a scale no startup's self-reported number
   can match.
2. **First-class integration across the agent frameworks** — LangChain,
   LlamaIndex, Vercel AI SDK, CrewAI, Haystack, Pydantic AI. Its own package and
   docs page, not a community wrapper.
3. **Sells retrieval over its own large index**, rather than reselling someone
   else's results.
4. **Capital raised specifically to sell web retrieval to AI builders.** The
   weakest of the four, and flagged wherever it's the only one a provider clears.

---

## The eight

| Provider | Why it's in | Returns |
|---|---|---|
| **Firecrawl** | Framework integration everywhere, and the largest open-source footprint in the market. Measured in run 1 | page text |
| **Exa** | Framework integration everywhere; its own index; $250M Series C at $2.2B; named in Cursor's own docs as what powers `@Web`. Clears all four signals — the only one that does. Measured in run 1 | page text |
| **Tavily** | The oldest and deepest framework integration history in agent tooling; acquired by Nebius in Feb 2026 for up to $400M. Measured in run 1 | page text |
| **Bright Data** | LangChain integration, ~$300M ARR. Narrower framework presence than the rest — **it is also in because run 1 measured it, and dropping it would break the comparison** | page text (via Web Unlocker) |
| **Brave** | **Powers Claude's web search** (Anthropic's own subprocessor list) **and Mistral's**. The only provider here with a documented placement inside a top-tier AI product, and it has never been publicly benchmarked | links ⚠️ |
| **Serper** | Bootstrapped, no funding story, and still the default Google-SERP choice across agent tutorials and framework examples. "Major" here means widely used, not well capitalized | links |
| **Perplexity Search** | A standalone API over Perplexity's own 200–300B page index — lab-scale retrieval sold directly. New in 2026, so no framework adoption yet | links |
| **Parallel** | $2B valuation inside a year, Notion and Harvey as named customers. **Clears signal 4 only — it showed up in no agent framework I checked.** In on capital and logos, and that asymmetry is stated rather than hidden | page text ⚠️ |

**Four adapters to write:** Brave, Serper, Perplexity Search, Parallel.

### What each score covers

Three of the four new providers return links and snippets rather than page text.
That is handled by scoring, not by exclusion, because run 2's headline reads web
addresses only:

| Score | Covers |
|---|---|
| Did the right page come back — run 2's headline | **all 8** |
| Did the text contain the required fact | the 5 that return page text |
| The two judge scores, kept so run 2 lines up with run 1 | the 5 that return page text |

Every published number carries the count of providers behind it. A score over five
providers printed beside one over eight, without saying so, is the same class of
mistake as a latency figure that was really measuring our own model.

---

## Can't be measured at all

Not a judgment about quality — these can't be arms in this design.

| | Why |
|---|---|
| **Google Custom Search JSON API** | Closed to new customers, in Google's own words. Retires 2027-01-01 |
| **Bing / Azure Bing Search** | Retired. `410 Gone` since 2025-08-11 |
| **Anthropic's web search tool** | Can't be called without generating a completion from a Claude model. Sourcery holds the answer model identical across providers, so a search tool welded to its own model can't be an arm |
| **OpenAI's web search tool** | Same |
| **Google's Grounding with Google Search** | Same — it returns grounded generations, not results. (~$14 per 1k queries, if you want it for something else) |
| **SearXNG** | Not a vendor. Open-source software you host, which scrapes other engines |
| **Marginalia** | A key means emailing the operator. No posted price |

---

## Qualify, but not measured

These meet the technical bar and would be measured on request. Listing them is the
point — it's the difference between *not asked for* and *quietly dropped*.

SerpAPI, Kagi, You.com, Valyu, Linkup, Mojeek's official API, Oxylabs,
ScrapingBee, ZenRows, Scrapfly, Apify, Jina, Diffbot, Webz.io.

Notes on a few: **Jina** was acquired by Elastic in Oct 2025 and its independent
relevance is fading. **SerpAPI** has no pay-as-you-go — $25/month for 1,000
searches is the floor — and its framework presence is community wrappers rather
than first-party integrations, which is what separates it from Serper. **Apify** is
a marketplace, not a provider; anything measured there has to pin an actor id and
version. **Mojeek's paid API is not what the keyless baseline uses** —
`core/adapters/plain.ts` scrapes Mojeek's HTML with no key, and the two must never
appear in one table without saying so.

---

## What isn't confirmed

Flagged rather than guessed. Each needs a signup and one real call — a docs page is
not evidence about a response shape.

- **Brave**: an "LLM Context" endpoint exists at the same $5 per 1k as web search.
  Not confirmed whether it returns extracted page text or richer snippets. **If it
  returns text, Brave moves into the judge-scored group** and the coverage counts
  above change from 5-of-8 to 6-of-8.
- **Parallel**: `full_content: true` returns full page markdown from the search
  call. Not confirmed whether it costs more than the base $5 per 1k.
- **Perplexity Search**: no free tier found. This is the standalone Search API, not
  Sonar — Sonar is a chat endpoint and is excluded above for the same reason as
  Anthropic's and OpenAI's tools.
- Region locks and hard rate limits: not checked for any provider. Absence of
  evidence, not evidence of absence.

**One claim about the labs is softer than it looks.** The Anthropic–Brave link
rests on Anthropic's subprocessor list, cross-confirmed by contemporaneous
reporting — but Anthropic has never stated it in a blog post or in the docs, and
the page couldn't be read directly. It's strong evidence, not a company statement,
and it gets described that way wherever it appears. There is also a second
web-search subprocessor on that list, turbopuffer, added May 2026, whose role
nobody has explained.

---

## What it costs

Ninety calls per provider — 54 questions once, plus 18 fetched twice more for the
consistency sample.

Trivial. Well under $20 across all eight, most of it absorbed by signup credits.
Money was never what a wide list cost; adapters were.

**One number is not trusted.** Firecrawl's public pricing implies about 900 credits
for 90 calls. Run 1 actually consumed 20–60 credits per call, putting 90 calls at
1,800–5,400. **The measured range wins** — section 6 of the plan keeps it. A credit
estimate derived from a docs page has not once matched what this project spent.

---

## Consequences for the plan

Settled while `preregistration-v2.md` is still a draft, because section 11 forbids
quietly editing it once the repo is tagged.

1. **"The gap" was defined as an average over the 6 pairs of 4 providers.** Eight
   providers is 28 pairs, which is a different measurement. Two are reported: the
   gap across all eight, and the gap across the original four, which is the only
   one comparable to run 1.
2. **Four providers have no run-1 result.** Stated, not hidden.
3. **Every score carries the count of providers it covers.**
