# Who gets measured, and why

Sourcery has measured four search providers: Firecrawl, Exa, Tavily and Bright
Data. **Nothing chose them.** They are the four somebody wrote an adapter for.

That was fine while nobody was reading. It stops being fine for run 2, which
answers a question raised by an engineer at Exa, partly paid for in Exa credits,
in a benchmark Exa currently wins. *Why isn't X in here* and *you left out the one
that beats you* both need an answer anyone can check, and "these are the ones I
built" is not one.

So the rule got written first, and the list found second. Doing it the other way
round produces a rule shaped to fit the list you already had.

---

## The rule

> **A provider is in if, as of the date of the run, it offers a web-search API
> anyone can sign up for, at a price published on a public page.**

*Anyone can sign up for* means you get a key without a sales call. *Price
published on a public page* means a number, not "contact us."

That's the whole rule. It says nothing about quality, popularity, or whether the
provider is any good — deciding those is what the benchmark is for.

**Twenty providers clear it. Sixteen of them have no adapter yet.**

---

## The complication, and how it's handled

Most of the twenty return **links and snippets only**. They don't fetch the page.

That matters because two of sourcery's three scores read page text. Hand a judge
eight full pages and it grades one thing; hand it eight one-line snippets and it
grades those lower — every time, reliably. But a snippet-only provider may have
returned exactly the right eight links. It didn't lose at search. It lost at a job
it doesn't sell.

The fix is not to throw those providers out. It's that **run 2's headline doesn't
read page text at all.** Section 7 of the plan makes the main number *did any of
the pre-registered answer pages appear among the eight results* — a comparison of
web addresses. A links-only provider can be measured on that exactly as fairly as
one that returns full text.

So the split is per score, not per provider:

| Score | Who it's fair to |
|---|---|
| **Did the right page come back** — run 2's headline | **Everyone.** Needs addresses only |
| Did the text it pulled contain the required fact | Only providers that return page text |
| The two judge scores, kept so run 2 lines up with run 1 | Only providers that return page text |

Every number gets published with the count of providers it covers. A score
reported over ten providers next to one reported over twenty, without saying so,
would be the same class of mistake as a latency figure that was really measuring
our own model.

**Note that the current four aren't uniform on this either.** Bright Data needs two
products to return content (SERP API plus Web Unlocker) and Exa needs two calls
(Search plus Contents). "Returns content in a single call" would have cut Exa,
which is one reason it isn't the criterion.

---

## Admitted

Sixteen of these need an adapter written — one file in `core/adapters/` plus a row
in `core/adapters/index.ts`. Prices are per that provider's public page as of
2026-08-12 and are checked again before the run.

### Returns page text

| Provider | Price | Free tier | How content arrives | Adapter |
|---|---|---|---|---|
| Firecrawl | 2 credits per 10 results, 1 credit per page scraped | 1,000 credits/mo | same `/search` call | ✅ |
| Exa | $7 per 1k searches, $1 per 1k pages | $20 signup, $10/mo | second call (Contents) | ✅ |
| Tavily | 1 credit basic, 2 advanced, $0.008/credit | 1,000 credits/mo | bundled, no extra charge | ✅ |
| Bright Data | $1.50 per 1k + Web Unlocker ~$1.50–3 per 1k | 5,000 records/mo | second product | ✅ |
| You.com | $5 per 1k, Contents $1 per 1k | $100 signup | second call | — |
| Valyu | $0.003 per result | $10–20 signup | bundled | — |
| Parallel | $5 per 1k | up to 80k requests free | `full_content: true`, same call ⚠️ | — |
| Kagi | $12 per 1k, Extract $4 per 1k | trial only | second call ⚠️ | — |
| Jina | token-metered ⚠️ | 10M tokens | fetches top results by default | — |
| Linkup | $0.005–0.006 per request, Fetch $0.001–0.005 | $20/mo | unclear ⚠️ | — |

### Returns links and snippets

Measured on the headline score only.

| Provider | Price | Free tier | Adapter |
|---|---|---|---|
| Brave Search | $5 per 1k ⚠️ | ~$5/mo credit | — |
| Serper | $1 per 1k down to $0.30 at volume | 2,500 one-time | — |
| SerpAPI | no pay-as-you-go — $25/mo floor for 1,000 | 250/mo | — |
| ScrapingBee | 10–15 credits/call, ~$0.0002/credit | 1,000 credits | — |
| Perplexity Search | $5 per 1k | not found | — |
| Oxylabs SERP | $0.80–1.00 per 1k | 2,000 results | — |
| ZenRows SERP | ~$2.80 per 1k | 5,000 credits/mo | — |
| Scrapfly SERP | from $30/mo, ~$0.30 per 1k at volume | 1,000 credits | — |
| Apify | $0.002/query — **pin the actor id and version** | $5/mo credit | — |
| Mojeek (official API) | £2–3 CPM | trial requires contact | — |

Two notes on that second table. **Apify is a marketplace, not a provider** — the
price above is for `apify/google-search-scraper` specifically, and a different
actor on the same platform is a different product with different reliability.
Whatever gets measured has to name the actor and version. And **Mojeek's official
paid API is not what the current keyless baseline uses** — `core/adapters/plain.ts`
scrapes Mojeek's HTML results with no key at all. They should never be confused
for each other in a results table.

---

## Not admitted, and why

The exclusions carry as much weight as the inclusions, so they get published too.

| Provider | Why |
|---|---|
| **Google Custom Search JSON API** | Closed to new customers. Google's own docs say so in those words, and the API retires 2027-01-01. Fails "anyone can sign up." |
| **Bing / Azure Bing Search** | Retired. Endpoints have returned `410 Gone` since 2025-08-11. |
| **Anthropic's web search tool** | Not a standalone search API. It runs inside the Messages API's own loop — you can't get raw results without generating a completion from a Claude model. Sourcery holds the answer model identical across providers, so a search tool welded to its own model can't be one of the arms. |
| **OpenAI's web search tool** | Same reason. |
| **SearXNG** | Not a vendor product — open-source software you host yourself, which scrapes other engines. There is no provider and no price. |
| **Marginalia** | Getting a key means emailing the operator, which is an approval step rather than self-signup, and no price is posted. |
| **Webz.io** | Public page lists tiers without a number. |
| **Diffbot** | Has a public price ($299/mo) but its search is over Diffbot's own knowledge graph, and it isn't confirmed that it takes an arbitrary natural-language web query the way the others do. Excluded pending that check rather than on principle. |

---

## What isn't confirmed

Flagged rather than filled in. Each needs signing up and making one real call —
a docs page is not evidence about a response shape.

- **Brave**: an "LLM Context" endpoint exists at the same price as web search. Not
  confirmed whether it returns extracted page text or just richer snippets. If it
  returns text, Brave moves up a table.
- **Parallel**: `full_content: true` returns full page markdown from the search
  call. Not confirmed whether it costs more than the base $5 per 1k.
- **Linkup**: not confirmed whether search results carry full text or excerpts.
  The existence of a separately-priced Fetch endpoint suggests excerpts.
- **Kagi**: content is mentioned as an add-on, but no per-page price separate from
  the $4 per 1k Extract API.
- **Jina**: no primary per-request price found, only token metering and
  third-party estimates. Also fetches the **top 5** results by default where
  sourcery asks for 8 — check the parameter before assuming parity.
- **Perplexity Search**: no free tier found. Note this is the standalone Search
  API, not Sonar; Sonar is a chat endpoint and is excluded for the same reason as
  Anthropic's and OpenAI's tools.
- Region locks and hard rate limits: not checked for any provider. Absence of
  evidence, not evidence of absence.

---

## What it costs

Ninety calls per provider — 54 questions once, plus 18 questions fetched twice
more for the consistency sample.

**Under $20 across all twenty providers**, and most of that is absorbed by signup
credits. Money is not what makes a wide list expensive; sixteen adapters is.

**One number here is not trusted.** Public pricing implies about 900 Firecrawl
credits for 90 calls. Run 1 actually consumed 20–60 credits per call, which puts
90 calls at 1,800–5,400. **The measured range wins** — section 6 of the plan keeps
it. A credit estimate derived from a docs page has never once matched what this
project actually spent.

---

## Consequences for the plan

Three, all to be settled while `preregistration-v2.md` is still a draft, because
section 11 forbids quietly editing it once the repo is tagged.

1. **"The gap" was defined as an average over the 6 possible pairs of 4
   providers.** Twenty providers is 190 pairs, and that is a different
   measurement. The definition is re-fixed against the final list before the tag.
2. **Sixteen providers have no run-1 result.** Run 2 lines up with run 1 for the
   original four only. Stated, not hidden.
3. **Every score carries the count of providers it covers.** The headline covers
   everyone; the other two cover the ones that return page text.
