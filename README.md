# sourcery

**Find the best search API for your agent.**

Which one should you point it at? It depends on what you're asking it, and nobody can answer that for you from a pricing page.

sourcery runs your queries through several web-search APIs with everything else held still. Same query, same answer model, same judge, swap only the retrieval provider, and see what actually changes. Five providers ship in the box and adding one is about forty lines.

I built it because I couldn't find a straight answer to that question while building a research agent, and the answers I did find were vendor benchmarks.

## Quickstart

```bash
git clone https://github.com/sameerhimati/sourcery && cd sourcery
npm install
npm run sourcery -- init
```

`npm install` builds the CLI, so there's no separate build step. `init` asks for your keys, writes `.env.local` and a config, and finishes by running a real query so you know it works before you trust anything.

Then:

```bash
npm run sourcery -- run "<any question>"   # one query, every provider you have keys for
npm run sourcery -- report                 # self-contained HTML from everything you've run
npm run sourcery -- batch                  # the built-in 48-query set, per-query heatmap
```

### You need two keys

One LLM key for the answer and judge steps, and at least one retrieval key for the thing actually being measured.

| what | where to get it | notes |
|---|---|---|
| **LLM** | [Fireworks](https://app.fireworks.ai/settings/users/api-keys) or [OpenAI](https://platform.openai.com/api-keys) | pick one. Fireworks is what `init` scaffolds by default |
| **Tavily** | [app.tavily.com](https://app.tavily.com/home) | free tier, no card. The fastest way to a first result |
| **Exa** | [dashboard.exa.ai](https://dashboard.exa.ai/api-keys) | free credits to start |
| **Firecrawl** | [firecrawl.dev](https://www.firecrawl.dev/app/api-keys) | metered in credits, and `--dry-run` will price a run first |
| **Bright Data** | [brightdata.com](https://brightdata.com/cp/setting/users) | needs three values: an API token plus two zone names, see [`docs/providers.md`](docs/providers.md) |

**Fireworks plus Tavily is enough**, both free, and gets you a scored result in well under a minute. Two retrieval keys is where it gets interesting, because that's the first point at which you're comparing anything.

If you'd rather not run the wizard, copy `.env.example` to `.env.local` and fill in what you have.

By default it compares whichever providers you have keys for. Name them explicitly when you want a specific pairing:

```bash
npm run sourcery -- run "<query>" --values firecrawl,tavily
```

Config, env and results are all read and written relative to wherever you run the command.

### Installing it as a tool

Once it's on npm the same commands work without a clone, as `sourcery`:

```bash
npx sourcery-eval init
npx sourcery-eval run "<query>"
```

Clone first if you want to read the code, which for an eval you're about to believe is not a bad instinct.

### Know what it costs before it spends

Retrieval APIs bill per call and a full batch isn't cheap, so you can price any run first.

```bash
sourcery batch --dry-run           # itemised estimate, spends nothing
sourcery batch --max-credits 400   # refuses to start if the estimate is over your ceiling
```

Fetches are cached for 24 hours, so re-judging something you already retrieved is free, and the estimate subtracts cached calls before it quotes you. Run `providers --check` before anything long. A key being set doesn't mean the account still has quota, and finding that out 200 calls into a two-hour run is expensive.

There is also a `plain` provider that needs no key at all, just a keyless SERP and a bare `fetch()`. Treat it as a control, not as a way to skip getting a key. Keyless search rate-limits hard: testing this from a clean machine it was captcha'd on the first attempt, and elsewhere a block survived 15 minutes of total silence and still didn't lift. A run with `plain` as its only provider will usually return you nothing at all, which is a finding about keyless search and not a way to evaluate anything.

Every run appends to `.sourcery/runs.jsonl`. That file is the contract. The terminal scorecard and the HTML report are both just views over it, and the report shows you every source each provider fetched, the answer built from it, and the judge's reasoning for both scores.

## The providers

| id | How far it's been measured | Keys needed | Shape |
|---|---|---|---|
| `bright_data` | well measured | 3 (token + 2 zone names) | Google SERP, then a separate unblocked fetch per URL |
| `firecrawl` | well measured | 1 | search and scrape in one call |
| `tavily` | lightly measured | 1 | RAG-tuned index, optional raw page content |
| `exa` | lightly measured | 1 | neural index, the only one with reliable native publish dates |
| `plain` | baseline only | none | keyless SERP and a bare `fetch()`, the free baseline |

That middle column is about my numbers, not about the products. Bright Data and Firecrawl went through the full set with repeats and two judges. Tavily and Exa got keyed later and have been through a much smaller pass, enough to know the adapter works and not enough to rank them. Your own run is what makes that column irrelevant.

An adapter is one function, `(query, config) => { sources, context }`, plus a row in the registry. That's the entire interface. Setup recipes, per-provider quirks, credit arithmetic and a full worked example are in [`docs/providers.md`](docs/providers.md).

### What a single search actually costs

Running this produced an incidental result about Firecrawl's billing that's worth writing down, because the published per-call pricing doesn't obviously predict it.

I'd assumed 10 credits per search. It's 20. Three controlled `/v2/search` calls at `limit: 8`, diffing `remainingCredits` between them, isolate where it goes.

| request | credits | what it isolates |
|---|---:|---|
| `sources: ["web"]`, no scrape | 2 | search on its own |
| `sources: ["web"]` + markdown | 10 | +8, so 1 credit per page scraped |
| `sources: ["web","news"]` + markdown | 20 | +10, so a second search *and* 8 more scrapes |

Asking for two source types buys two searches and two sets of scrapes. Real calls bill 20 to 65, going higher when Firecrawl escalates to a browser rendering path, and government statistics pages were consistently the worst. That's the difference between a 48-query batch costing 1,000 credits and costing 5,000, which is why `--dry-run` exists. The method and the levers that bring it down are in [`docs/providers.md`](docs/providers.md).

## What I found when I ran it

I ran the built-in set across all four providers. The write-up is in [**docs/findings.md**](docs/findings.md). The short version, and the reason this tool reports two scores instead of one:

**How good the sources are and how good the answer is barely relate to each other.** They correlate at r = 0.16, which is essentially not at all. A provider can hand back stale, off-topic, half-extracted junk and the answer built on top still reads well, because the model is answering from what it already knew. Grade a search API on the answer downstream of it and you are mostly grading your own model.

One query breaks it both ways at once. Exa fetched the right Apple page, answered correctly off it, and scored **0** on the answer because the judge itself was a year out of date. Tavily retrieved nothing usable and scored **9**, answering from memory.

**The two I measured properly tied on quality and split on reliability.** Firecrawl failed 2 calls out of 240, Bright Data failed 61. Both returned sources around 290 days old for questions asking what is newest, so freshness is unsolved rather than solved by either of them.

**And an earlier version of this fooled me.** Twelve queries, one judge, no repeats, and it said Bright Data wrote better answers by 2.6 points. I had a tidy story for why. Run properly, the gap vanished. It was noise, and catching that is the whole reason to build one of these.

[Read the full write-up, with the tables and the caveats](docs/findings.md)
## Use it from an agent

sourcery ships an MCP server on the same binary, so the eval is something an agent can consult rather than something a human reads afterwards. Two tools:

| tool | cost | what it does |
|---|---|---|
| `which_provider` | one LLM call, no retrieval | Classifies a query into one of the six types and returns whichever provider scored best on that type in your eval history. Use it to pick a backend. |
| `evaluate_retrieval` | slow, metered, live provider and LLM calls | Runs one query across several providers with everything else held constant and returns per-provider scores. Use it to prove one. |

The cheap one is the useful pattern. Before an agent spends a retrieval call it can ask which backend has actually done best on this kind of question and route accordingly, which is evidence instead of a hardcoded default for the price of a single classification. With no local history yet it falls back to my shipped numbers and says so, including which providers those numbers can't speak for.

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

The judge defaults to a stale model on purpose. The anti-cheat needs the judge's cutoff to predate the queries, so a fresher judge only affects the answer score and never the primary source score. The iPhone example above is what that tradeoff looks like when it bites.

## Stack

TypeScript, a Commander CLI over a framework-free [`core/`](core/), an MCP server on the same binary, and retrieval adapters in [`core/adapters/`](core/adapters/).

MIT © [Sameer Himati](https://sameerhimati.com).
