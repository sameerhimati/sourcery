# sourcery

**Find the best search API for your agent.**

[![Sourcery Search Benchmark: Search API Retrieval Eval. Finding the best search for your agents. Run 2: 204 questions, eight providers, three judges.](https://raw.githubusercontent.com/sameerhimati/sourcery/main/docs/media/card.png)](https://sameerhimati.com/sourcery/)

sourcery asks the same question of several web-search APIs with everything else held still — same prompts, same judges, same settings — and scores the pages that come back. Only the retrieval provider changes.

I built it because I could not get a straight answer to that question while building a research agent, and the answers I found were vendor benchmarks.

**[Read the full report →](https://sameerhimati.com/sourcery/)**: eight providers, 204 questions, 22,457 page ratings from three judges. One provider is clear of the field and most of the rest of the ranking is noise, which the page shows rather than hides. The [methodology](https://sameerhimati.com/sourcery/methodology/) is a page of its own, and every individual rating is in [the explorer](https://sameerhimati.com/sourcery/explorer/) with the sentence the judge wrote for it.

## Install

```bash
npx sourcery-eval init
```

`init` asks for your keys, writes `.env.local` and a config, then runs a real question so you know it works before you trust anything.

From a clone:

```bash
git clone https://github.com/sameerhimati/sourcery && cd sourcery
npm install            # also builds the CLI
npm run sourcery -- init
```

## Run it

```bash
sourcery run "<any question>"   # one question, every provider you have keys for
sourcery report --tui           # everything you have run, in the terminal
sourcery batch                  # the built-in question set, with a per-question heatmap
sourcery providers              # which providers you have keys for
```

![One question going out to four providers in parallel, each scored on the sources it returned and the answer built from them](https://raw.githubusercontent.com/sameerhimati/sourcery/main/docs/media/hero.gif)

<sub>A real run, played back at 7×, recorded when the harness carried four providers rather than eight. **[Longer walkthrough](docs/media/demo.mp4)** — providers, a run, the report, and wiring it into a coding agent, in a minute.</sub>

## Get your keys

You need one model key for the answer and judge steps, and at least one retrieval key for the thing being measured.

For the model, Groq is free, needs no card, and is the fastest, which is why `init` offers it first. Fireworks, OpenAI, and Anthropic also work. Any OpenAI-compatible backend works, including one on your own hardware.

For retrieval, pick any of these:

| Provider | Keys | What it returns |
|---|---|---|
| `perplexity` | `PERPLEXITY_API_KEY` | Relevance-selected excerpts, not whole pages |
| `brave` | `BRAVE_API_KEY` | Search snippets joined together. Never a page body |
| `parallel` | `PARALLEL_API_KEY` | Dense excerpts you cannot turn off |
| `exa` | `EXA_API_KEY` | Page text at Exa's own default length |
| `tavily` | `TAVILY_API_KEY` | Full page markdown, with links and images intact |
| `serper` | `SERPER_API_KEY` | Links and snippets. No page content at all |
| `firecrawl` | `FIRECRAWL_API_KEY` | Full page markdown |
| `bright_data` | `BRIGHTDATA_API_TOKEN` plus two zone names | Google SERP, then a separate unblocked fetch per URL |
| `plain` | none | A keyless SERP and a bare `fetch()`. A control, not a product — it gets captcha'd |

Tavily has a free tier and needs no card, so **Groq plus Tavily gets you a scored result in about a minute**. Two retrieval keys is where it starts comparing anything.

### Know what a run costs before it spends

Retrieval APIs bill per call, so price a run first:

```bash
sourcery batch --dry-run           # itemised estimate, spends nothing
sourcery batch --max-credits 400   # refuses to start if the estimate is over your ceiling
```

Fetches are cached for 24 hours, so re-judging something you already retrieved is free, and the estimate subtracts cached calls before it quotes you. Run `sourcery providers --check` before anything long: a key being set does not mean the account still has quota, and finding that out 200 calls into a two-hour run is expensive.

## Run your own questions

The built-in set probes freshness. Yours are the ones that matter, and they are nothing like these:

```bash
sourcery batch --queries-template > my-queries.json   # a starting point
sourcery batch --queries my-queries.json              # run them
```

The file is a JSON array, or one JSON object per line if that is what your query log gives you:

```json
[
  { "type": "product_lookup", "query": "What are the current pricing tiers for <product>?" },
  { "type": "how_to", "query": "How do I configure <tool> to do <specific thing>?" }
]
```

`id` is optional. `type` must be one of six values — `breaking_news`, `how_to`, `product_lookup`, `local_geo`, `recent_release`, `numeric_live` — because the heatmap, the MCP classifier, and `which_provider`'s routing all key off it.

Results land in `.sourcery/runs.jsonl`, so `which_provider` starts answering from your questions rather than from mine. That file is the contract: the terminal scorecard and the HTML report are both views over it.

For a curated starting point, [`datasets/real-tasks.json`](datasets/real-tasks.json) holds 24 real retrieval tasks — pay bands on open roles, S3 request pricing, which clinic near you is open right now — each with a written acceptance criterion.

## Use it from an agent

sourcery ships an MCP server on the same binary, so an agent can consult the eval instead of a human reading it afterwards.

| Tool | Cost | What it does |
|---|---|---|
| `which_provider` | One model call, no retrieval | Classifies a question and returns whichever provider scored best on that type in your history |
| `evaluate_retrieval` | Slow and metered: live provider and model calls | Runs one question across several providers with everything else held constant |

The cheap one is the useful pattern. Before an agent spends a retrieval call it asks which backend has done best on this kind of question and routes accordingly, which one classification call buys you instead of a hardcoded default. With no local history it falls back to the shipped numbers and says so.

```bash
sourcery mcp --install                                # prints the snippet for your client
claude mcp add sourcery -- npx -y sourcery-eval mcp   # Claude Code
codex mcp add sourcery -- npx -y sourcery-eval mcp    # Codex
```

Run your agent from the directory holding `.sourcery/runs.jsonl`. The server resolves that path relative to its working directory, and from anywhere else you get my numbers instead of yours.

To hand this to an agent, point it at [llms.txt](https://sameerhimati.com/sourcery/llms.txt) — one URL, and it finds the tools, the scores and how to read them.

## Bring your own model

The retrieval provider is the variable. The model is yours.

The answer step and both judges go through one provider-agnostic seam, so you can point the whole eval at any OpenAI-compatible backend. A model is a `provider/model` reference, and a bare id such as `gpt-4o-mini` means OpenAI.

```bash
sourcery run "<question>" --model gpt-4o-mini

sourcery run "<question>" \
  --model groq/llama-3.3-70b-versatile \
  --judge groq/llama-3.3-70b-versatile
```

An eval of your retrieval stack only means something if it runs the model you ship. Which model is best is a question this deliberately does not answer.

## Two things worth knowing

**An earlier version of this fooled me.** Twelve questions, one judge, no repeats, and it reported that one provider wrote better answers by 2.6 points. I had a tidy story for why. Run properly, the gap vanished. Catching that is the whole reason to build one of these.

**Every small failure count this project has published turned out to be mine rather than a vendor's** — a billing lapse, a client timeout, a batch identifier too long for an API that caps them. The harness now tags which step of a run threw, so a judge that dies is never charged to a search API.

## Docs

| | |
|---|---|
| [Full report](https://sameerhimati.com/sourcery/) | eight providers, 204 questions, and what each one is good for |
| [Methodology](https://sameerhimati.com/sourcery/methodology/) | the two rubrics, the settings held identical, and what one run cannot tell you |
| [Explorer](https://sameerhimati.com/sourcery/explorer/) | every rating, with the sentence each judge wrote to justify it |

The write-ups used to be a shelf of markdown in `docs/`. They said the same
things as the site and drifted from it, so the site is the only copy now; the
repo is code.

Adding a provider is one file in [`core/adapters/`](core/adapters/) plus a row in the registry. An adapter is one function: `(query, config) => { sources, context }`.

TypeScript, a Commander CLI over a framework-free [`core/`](core/), an MCP server on the same binary.

MIT © [Sameer Himati](https://sameerhimati.com).
