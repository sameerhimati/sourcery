# sourcery

**Find the best search API for your agent.**

Which one is best depends on what you're asking it, and nobody can answer that for you from a pricing page.

sourcery runs your queries through several web-search APIs with everything else held still. Same query, same answer model, same judge, swap only the retrieval provider, and see what actually changes. Five providers ship in the box and adding one is about forty lines.

I built it because I couldn't find a straight answer to that question while building a research agent, and the answers I did find were vendor benchmarks.

## What I found when I ran it

![Retrieval and answer scores side by side for every provider — the retrieval bars are roughly half the length of the answer bars in every case](https://raw.githubusercontent.com/sameerhimati/sourcery/main/docs/media/retrieval-vs-answer.png)

<sub>`sourcery report --tui`, from my own run log. Every provider's answer scores well above its sources.</sub>

**Fetching good pages didn't mean giving good answers.** Rank the providers by how good their fetched pages were, then rank them again by how good the final answer was, and the order scrambles. A provider can hand back stale, off-topic, half-extracted junk and the answer built on top still reads fine, because the model is answering from what it already knew. The answer score is mostly a score of your model, not of the search API. That is why this reports two numbers instead of one.

One query breaks it both ways at once. Exa fetched the right Apple page, answered correctly off it, and scored **0** on the answer because the judge itself was a year out of date. Tavily retrieved nothing usable and scored **9**, answering from memory.

**Firecrawl, Bright Data and Tavily tie on source quality. Exa doesn't.** Across 960 results — 48 queries, four providers, five fresh fetches each, two judges — Exa scores 6.45 ± 0.52 where the other three sit between 3.95 and 4.78 with overlapping error bars. It is the only gap big enough that the error bars do not overlap. The reason is freshness: Exa's median source is 35 days old, everyone else's is 286 to 318.

On reliability, Exa, Firecrawl and Tavily each returned something on all 240 calls; Bright Data failed 61. Every small failure count this eval has ever published turned out to be mine rather than a vendor's — Firecrawl's two were my billing, Exa's and Tavily's one apiece were my own LLM client timing out and being recorded against the provider. The harness now tags which step of a run threw, so a judge that dies can't be charged to a search API.

**And an earlier version of this fooled me.** Twelve queries, one judge, no repeats, and it said Bright Data wrote better answers by 2.6 points. I had a tidy story for why. Run properly, the gap vanished. It was noise, and catching that is the whole reason to build one of these.

[Read the full write-up, with the tables and the caveats →](docs/findings.md)

## Quickstart

```bash
npx sourcery-eval init
```

`init` asks for your keys, writes `.env.local` and a config, and finishes by running a real query so you know it works before you trust anything.

Then:

```bash
sourcery run "<any question>"   # one query, every provider you have keys for
sourcery report --tui           # everything you've run, in the terminal (drop --tui for HTML)
sourcery batch                  # the built-in 48-query set, per-query heatmap
```

![One query through Firecrawl, Tavily, Exa and Bright Data, each scored separately on the sources it returned and the answer built from them](https://raw.githubusercontent.com/sameerhimati/sourcery/main/docs/media/hero.gif)

<sub>A real run, played back at 7×. Three of those four returned mediocre sources and still scored 9–10 on the answer. One query and one judge, so read it as the mechanism, not a ranking. **[Longer walkthrough](docs/media/demo.mp4)** — providers, a run, the report, and wiring it into a coding agent, in a minute.</sub>

### You need two keys

One LLM key for the answer and judge steps, and at least one retrieval key for the thing actually being measured.

**The model key**, for answering and grading:

| | where | notes |
|---|---|---|
| **Groq** | [console.groq.com/keys](https://console.groq.com/keys) | **free, no card, and the fastest.** What `init` offers first |
| Fireworks | [app.fireworks.ai](https://app.fireworks.ai/settings/users/api-keys) | open models, including stale ones that make better judges |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-4o-mini` answers and grades |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Claude answers well, but see the note on judges |

**The search key**, at least one:

| | where | notes |
|---|---|---|
| **Tavily** | [app.tavily.com](https://app.tavily.com/home) | **free tier, no card.** Quickest to a first result |
| Exa | [dashboard.exa.ai](https://dashboard.exa.ai/api-keys) | free credits to start |
| Firecrawl | [firecrawl.dev](https://www.firecrawl.dev/app/api-keys) | metered in credits; `--dry-run` prices a run before it spends |
| Bright Data | [brightdata.com](https://brightdata.com/cp/setting/users) | three values, see [`docs/providers.md`](docs/providers.md) |

**Groq plus Tavily needs no card and gets you a scored result in about a minute.** Two search keys is where it gets interesting. That is the first point where you are comparing anything.

**A note on judges**, since it explains a choice that looks odd. The grader should be a model whose training ended *before* the questions were asked, so it can't score an answer highly just by already knowing the answer. That's why `init` pairs newer answer models with older graders, and why a current Claude judging its own output will sometimes call a correctly-sourced answer a hallucination. [The findings](docs/findings.md) has a worked example.

Config, env and results are all read and written relative to wherever you run the command. Name providers explicitly with `--values firecrawl,tavily` when you want a specific pairing.

### From a clone

Clone it if you want to read the code. For an eval you are about to believe, that is worth doing. Every command works the same, spelled `npm run sourcery -- <command>`:

```bash
git clone https://github.com/sameerhimati/sourcery && cd sourcery
npm install                              # also builds the CLI; no separate build step
npm run sourcery -- init
```

[`ARCHITECTURE.md`](ARCHITECTURE.md) maps every file to what it does.

### Know what it costs before it spends

Retrieval APIs bill per call and a full batch isn't cheap, so you can price any run first.

```bash
sourcery batch --dry-run           # itemised estimate, spends nothing
sourcery batch --max-credits 400   # refuses to start if the estimate is over your ceiling
```

Fetches are cached for 24 hours, so re-judging something you already retrieved is free, and the estimate subtracts cached calls before it quotes you. Run `providers --check` before anything long — a key being set doesn't mean the account still has quota, and finding that out 200 calls into a two-hour run is expensive. Full credit arithmetic is in [`docs/providers.md`](docs/providers.md).

Every run appends to `.sourcery/runs.jsonl`. That file is the contract. The terminal scorecard and the HTML report are both just views over it, and the report shows every source each provider fetched, the answer built from it, and the judge's reasoning for both scores.

## Run it on your own queries

The built-in 48 are freshness probes. Yours are the ones that matter, and they're nothing like these:

```bash
sourcery batch --queries-template > my-queries.json   # a starting point
sourcery batch --queries my-queries.json              # run them
```

The file is a JSON array, or one JSON object per line if that's what your query log gives you:

```json
[
  { "type": "product_lookup", "query": "What are the current pricing tiers for <product>?" },
  { "type": "how_to", "query": "How do I configure <tool> to do <specific thing>?" }
]
```

`id` is optional. `type` must be one of the six built-in types — `breaking_news`, `how_to`, `product_lookup`, `local_geo`, `recent_release`, `numeric_live` — because the heatmap, the MCP classifier and `which_provider`'s routing all key off them.

Results land in the same `.sourcery/runs.jsonl`, so `which_provider` starts answering from your queries rather than my numbers.

If you'd rather start from a curated set, [`datasets/real-tasks.json`](datasets/real-tasks.json) is 24 real retrieval tasks — comp bands on open roles, S3 request pricing, which clinic near you is open right now — each with a written acceptance criterion. [`docs/datasets.md`](docs/datasets.md) explains how it differs from the built-in 48.

## The providers

| id | How far it's been measured | Keys needed | Shape |
|---|---|---|---|
| `bright_data` | well measured | 3 (token + 2 zone names) | Google SERP, then a separate unblocked fetch per URL |
| `firecrawl` | well measured | 1 | search and scrape in one call |
| `tavily` | well measured | 1 | RAG-tuned index, optional raw page content |
| `exa` | well measured | 1 | neural index, the only one with reliable native publish dates |
| `plain` | baseline only | none | keyless SERP and a bare `fetch()`, the free baseline |

That middle column says how much I have measured. It says nothing about how good the product is. All four keyed providers have been through the full 48-query set with five fresh fetches each and a two-judge panel — 960 results. `plain` is a control: a keyless SERP that gets captcha'd on the first call has nothing to measure, and a run with `plain` as its only provider will usually return you nothing at all. Your own run is what makes that column irrelevant.

An adapter is one function, `(query, config) => { sources, context }`, plus a row in the registry. That's the entire interface. Setup recipes, per-provider quirks and credit arithmetic are in [`docs/providers.md`](docs/providers.md).

## Use it from an agent

sourcery ships an MCP server on the same binary, so an agent can consult the eval instead of a human reading it afterwards. Two tools:

| tool | cost | what it does |
|---|---|---|
| `which_provider` | one LLM call, no retrieval | Classifies a query into one of the six types and returns whichever provider scored best on that type in your eval history. Use it to pick a backend. |
| `evaluate_retrieval` | slow, metered, live provider and LLM calls | Runs one query across several providers with everything else held constant and returns per-provider scores. Use it to prove one. |

The cheap one is the useful pattern. Before an agent spends a retrieval call it can ask which backend has actually done best on this kind of question, and route accordingly. One classification call buys you that instead of a hardcoded default. With no local history it falls back to my shipped numbers and says so.

```bash
sourcery mcp --install                                # prints the snippet for your client
claude mcp add sourcery -- npx -y sourcery-eval mcp   # Claude Code
codex mcp add sourcery -- npx -y sourcery-eval mcp    # Codex
```

Run your agent from the directory holding `.sourcery/runs.jsonl` — the server resolves it relative to its working directory, and from anywhere else you get my numbers instead of yours.

Three things to hand an agent: [`mcp/README.md`](mcp/README.md) for the server itself, [`docs/agent-prompt.md`](docs/agent-prompt.md) for a block to paste into a system prompt, and [`llms.txt`](llms.txt) if you'd rather point an agent at one URL.

## Bring your own model

The retrieval provider is the variable. The model is yours to pick.

The answer step and both judges go through one provider-agnostic seam, so you can point the whole eval at any OpenAI-compatible backend including something on your own hardware. A model is a `provider/model` ref, and a bare id like `gpt-4o-mini` means OpenAI.

```bash
sourcery run "<query>" --model gpt-4o-mini

sourcery run "<query>" \
  --model groq/llama-3.3-70b-versatile \
  --judge groq/llama-3.3-70b-versatile
```

An eval of your retrieval stack only means something if it runs the model you actually ship. "Which model is best" is a question this deliberately will not answer for you. Adding another OpenAI-compatible backend is a single row in [`core/llm/`](core/llm/).

## Docs

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | where everything lives, and one question's path through the code |
| [`docs/findings.md`](docs/findings.md) | the full write-up of the 960-result run |
| [`docs/datasets.md`](docs/datasets.md) | the question sets and the rules for editing them |
| [`docs/providers.md`](docs/providers.md) | setup, quirks, and what each provider actually costs |
| [`docs/preregistration-v2.md`](docs/preregistration-v2.md) | the plan for the next run, published before it runs |

TypeScript, a Commander CLI over a framework-free [`core/`](core/), an MCP server on the same binary, retrieval adapters in [`core/adapters/`](core/adapters/).

MIT © [Sameer Himati](https://sameerhimati.com).
