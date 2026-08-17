# How this repo is put together

Sourcery asks the same question to several web-search APIs, feeds each one's
results to the same model, and has the same judges grade what came back. Every
part of the pipeline is held identical except which search API fetched the pages,
so any difference in score has to come from retrieval.

This file is the map. It answers "where is the thing that does X" without you
having to read the code to find out.

---

## Where do I find…?

| I'm looking for | It's here |
|---|---|
| **The questions** we ship | `core/eval-dataset.ts` (the 48) · `datasets/real-tasks.json` (the 24) · run 2's 200: `datasets/run2-questions.json` (96) + `datasets/run2-hard.json` (96, harder on purpose) + `datasets/run2-unanswerable.json` (8 that nothing can answer, never scored) |
| **Loading your own questions** | `core/query-set.ts` parses the file, `cli/query-file.ts` reads it off disk |
| **The code that calls each search API** | `core/adapters/` — one file per provider |
| **The code that calls the LLM** | `core/llm/` — one shared door for every model call |
| **Writing the answer** | `core/answer.ts` |
| **Grading the fetched pages** (the main score) | `core/retrievalJudge.ts` |
| **Grading the written answer** (the second score) | `core/judge.ts` |
| **Grading one page at a time** (run 2) | `core/relevanceJudge.ts` — a rung 0–3 per question-and-page pair |
| **Grading a whole returned set** (run 2) | `core/setJudge.ts` — 0–10 over everything one provider returned |
| **What the model already knew** | `core/noSearch.ts` — answers every question with zero sources, so questions retrieval couldn't have helped with can be told apart from the rest |
| **The settings held identical across providers** | `core/controls.ts` |
| **Running one question through one provider** | `core/orchestrator.ts` |
| **Running the whole matrix** | `core/batch.ts` (quick) · `core/credibility.ts` (the real one) |
| **Where results get written** | `core/records.ts` → `.sourcery/*.jsonl` |
| **The command-line commands** | `cli/index.ts` and `cli/commands/` |
| **The MCP server** | `mcp/` |
| **Findings and methodology** | `docs/` |

---

## The path of a single question

This is a real sequence, so the numbers mean something — each step feeds the next.

**1. A question comes from somewhere.**
Either the built-in 48 (`core/eval-dataset.ts`), the 24 realistic tasks
(`datasets/real-tasks.json`), or a file you passed with `--queries`. Your own file
is parsed by `core/query-set.ts`, which enforces the one real constraint: every
question must be one of six types, because the heatmap, the router, and the MCP
classifier all key off those six.

**2. Each search provider fetches pages for it.**
`core/adapters/` holds one file per provider — `firecrawl.ts`, `exa.ts`,
`tavily.ts`, `brightdata.ts`, plus `plain.ts`, a keyless baseline that shows what
you get for $0 with no account anywhere. `index.ts` is the registry that maps a
provider name to its adapter; `fetchSources()` there is the single entry point.
**Adding a provider is one new file plus one registry line** — nothing else in the
codebase needs to know about it.

**3. Page content gets pulled out.**
Most adapters return usable page text themselves. `core/extract.ts` handles the
Bright Data path, where search results have to be fetched separately to get real
page content rather than a one-line snippet. `core/date.ts` normalises publish
dates, which every provider reports in a different shape and often not at all.

**4. The same model writes an answer from those pages.**
`core/answer.ts`. Same model, same prompt, same temperature for every provider —
that's the point. All of it comes from `core/controls.ts`.

**5. Two judges grade it.**
`core/retrievalJudge.ts` grades the *fetched pages* — this is the score that
decides things, because it's the closest thing to grading retrieval itself.
`core/judge.ts` grades the *written answer*, kept as a second opinion. Both
prompts live in `core/controls.ts`.

**6. The result gets written to a file.**
`core/records.ts` owns the write path. One line of JSON per result, appended,
never overwritten, always local. **That file is the contract** — the terminal
scorecard, the HTML report, and every summary are just different views over it.

---

## The two ways to run it

They are not interchangeable, and mixing their output is the easiest mistake to
make here.

**`batch`** — one fetch per question, one judge, no error bars. Fast and cheap.
Use it to try things out. Writes to `.sourcery/runs.jsonl`.

**`credibility`** — repeat fetches, a panel of judges, error bars on every number,
and `--resume` so a run that dies partway through picks up where it stopped. This
is what published numbers come from. Writes to `.sourcery/s2-runs.jsonl`.

Anything that goes into a published table has to come from `credibility`. A
`batch` number sitting next to a `credibility` number is comparing two different
things.

---

## Things that exist because something went wrong

Worth knowing about, because each one is load-bearing:

- **`core/stage.ts`** — tags *which step* of a run failed. A retrieval call and
  three LLM calls all happen per result, and any of them can throw an error that
  names nobody. Without this, an LLM timeout gets recorded against a search
  provider that did nothing wrong. A failure we can't place is recorded as
  `unknown` and charged to no one.
- **`core/preflight.ts`** — estimates cost before a run starts. Exists because a
  240-result run once ground for two hours and then died on billing errors partway
  through, with no warning.
- **`core/fetch-cache.ts`** — caches the fetch step, which is the only part that
  costs real money. Repeat fetches each keep their own cache entry, so re-running
  the same question five times still means five genuinely separate fetches.
- **`core/credibility.ts`** also holds the circuit breakers: it stops the run when
  the network dies or a provider is clearly dead, rather than burning the rest of
  the matrix into a wall.

---

## The rest

**`cli/`** — `index.ts` wires up six commands anyone can see — `run`, `batch`,
`report`, `providers`, `init`, `mcp` — plus three hidden research ones:
`credibility`, `pooled`, `calibrate`. Each lives in `cli/commands/`. Views over
the results live in `cli/format.ts` (terminal), `cli/report-html.ts`, and
`cli/report-tui.ts`.

**`mcp/`** — the MCP server, so an agent can ask which provider to use for a given
question. `mcp/classify.ts` sorts a question into one of the six types;
`core/routing.ts` aggregates whatever you've already run into a recommendation.

**`docs/`** — `findings.md` is the published write-up, `datasets.md` explains the
question sets and the rules for editing them, `preregistration-v2.md` is the plan
for the next run.

---

## Before you change anything

- **The 48 questions in `core/eval-dataset.ts` are frozen.** The published result
  is anchored to them; editing them invalidates that result rather than improving
  it. New questions go in a new file.
- **`core/controls.ts` is the experiment.** Every prompt and setting in there is
  held identical across providers on purpose. Changing one means old results and
  new results are no longer comparable — which is sometimes right, but never
  accidental.
- **`core/types.ts` is a shared contract.** Providers are a registry, not a fixed
  list, specifically so adding one doesn't require editing it.
