# Index

Everything in this repo, and which file answers which question.

## Start here

| | |
|---|---|
| [`../README.md`](../README.md) | what sourcery is, how to run it, what the first run found |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | where every file lives, and one question's path through the code |
| [`../AGENTS.md`](../AGENTS.md) | rules for anyone (human or agent) changing the code |

## Results and method

| | |
|---|---|
| [`findings.md`](findings.md) | the full write-up of run 1 — 48 questions, 4 providers, 960 results |
| [`eval-harness.md`](eval-harness.md) | **the method in one page** — seven rules for an honest search eval, readable cold |
| [`preregistration-v3.md`](preregistration-v3.md) | **the plan of record for run 2** — what will be measured, how, and what would prove it wrong |
| [`s2-summary.json`](s2-summary.json) | run 1's numbers as data, per provider and per question type |
| [`preregistration-v2.md`](preregistration-v2.md) | **superseded** — a plan that was published in advance and then abandoned, kept with the reasons |
| [`run-2-build.md`](run-2-build.md) | **superseded** — its build order is dead; three findings about the code in it are not |
| [`provider-admission.md`](provider-admission.md) | the rule for which providers get measured, who it admits, and who it excludes and why |
| [`datasets.md`](datasets.md) | the question sets, how they differ, and the rules for editing them |

## Using it

| | |
|---|---|
| [`providers.md`](providers.md) | setup for each provider, their quirks, and what they actually cost |
| [`agent-prompt.md`](agent-prompt.md) | a block to paste into a system prompt so an agent can use sourcery |
| [`../mcp/README.md`](../mcp/README.md) | the MCP server — install, both tools, response shapes |
| [`../llms.txt`](../llms.txt) | the machine-readable index, if you'd rather point an agent at one URL |

## Questions

| | | |
|---|---|---|
| [`../core/eval-dataset.ts`](../core/eval-dataset.ts) | 48 | freshness probes — "what is the latest X". **Frozen**, run 1 is anchored to them |
| [`../datasets/real-tasks.json`](../datasets/real-tasks.json) | 24 | work someone actually does. Written, not yet run |
| [`../datasets/run2-questions.json`](../datasets/run2-questions.json) | 96 | what run 2 is measured on. Half of each type has one checkable answer, half could be answered well by several pages. Written, not yet run |

## Code, in one line each

| | |
|---|---|
| `core/adapters/` | one file per search provider — this is where a new provider goes |
| `core/llm/` | one shared door for every model call |
| `core/answer.ts` | writes the answer from the fetched pages |
| `core/retrievalJudge.ts` | grades the fetched pages — the score that decides things |
| `core/judge.ts` | grades the written answer — the second opinion |
| `core/controls.ts` | every setting held identical across providers. **This is the experiment** |
| `core/orchestrator.ts` | one question through one provider |
| `core/batch.ts` | the quick run — one fetch, one judge, no error bars |
| `core/credibility.ts` | the real run — repeats, judge panel, error bars, resumable |
| `core/pooled.ts` | the run 2 instrument — one fetch per question and provider, judge the pool, score against it |
| `core/pool.ts` | collapses every page every provider returned into one set of unique question-and-page pairs |
| `core/relevanceJudge.ts` | run 2's judge — one question, one page, a rating from 0 to 3 |
| `core/anchors.ts` | scores a candidate judge against pairs a human already settled, so a bad judge is caught before the run |
| `core/stage.ts` | tags which step failed, so a provider never eats our bug |
| `core/records.ts` | the write path. `.sourcery/*.jsonl` is the contract |
| `cli/` | six commands anyone can see — `run`, `batch`, `report`, `providers`, `init`, `mcp` — plus three hidden research ones: `credibility`, `pooled`, `calibrate` |
| `mcp/` | the MCP server, so an agent can consult the eval instead of a human reading it |

## Demo assets

[`demo-script.md`](demo-script.md) and [`media/`](media/) — the recordings in the
README and how they were made.
