# Using sourcery to evaluate web retrieval

Paste the block below into an agent's instructions (a `SKILL.md`, a system
prompt, a `CLAUDE.md`) to teach it how to drive sourcery. Everything in it is
checked against the real command surface.

If your agent speaks MCP, prefer [the MCP server](#mcp-the-server-agents-should-actually-use)
— same engine, no shelling out, structured results.

---

```markdown
## sourcery — pick a web-retrieval backend with evidence

sourcery compares web-retrieval providers on YOUR queries with YOUR model, so a
retrieval backend can be chosen from measurements instead of vibes. It holds
everything else constant — same answer model, same prompts, same judge — so the
only thing differing between arms is retrieval.

### When to reach for it
- Building RAG or a research agent, and the retrieval provider was never validated.
- Answers are stale or wrong and you suspect retrieval rather than the model.
- Choosing between Firecrawl / Bright Data / Tavily / Exa / a keyless baseline.

### Commands
- `sourcery providers --check` — which providers are configured, and whether the
  account will actually serve a run. Run this first; a key being set does not
  mean the account has quota.
- `sourcery run "<query>" --values a,b` — one query through two providers, scored
  side by side.
- `sourcery batch` — the built-in 48-query set across providers, as a per-type table.
- `sourcery report` — self-contained HTML from the run log.

Bring your own model: `--model <provider>/<model>` for any OpenAI-compatible
backend (e.g. `--model fireworks/accounts/fireworks/models/kimi-k2p6`).

The judge is set separately with `--judge`, and does NOT follow `--model`:
handing the judge a fresher training cutoff would break the anti-cheat the query
set depends on. Both default to an OpenAI model, so **without an OpenAI key you
must pass both** — `--model` alone will still fail on the judge step.

Results append to `.sourcery/runs.jsonl` in the working directory. That file is
the contract; the terminal table and the HTML report are both views over it. Run
commands from the project root or the history won't accumulate.

### How to read the output
- **retrieval_score (0–10) is the primary number.** It grades the SOURCES that
  came back — fresh? on-topic? real? — and never sees the answer.
- **answer_score (0–10) is secondary.** The answer judge can penalize a correct
  answer about events after its training cutoff, so trust it less.
- **Always read the error column.** Arms never throw; a failure is recorded, not
  hidden. A provider that scores slightly higher while failing a quarter of its
  calls is the worse choice, and this tool will say so.
- The winner is the best retrieval_score among arms that did not error.

### Costs, before you run anything
A `run` is a handful of provider calls plus 2–3 LLM calls per arm. A full `batch`
is 48 queries × every provider — on Firecrawl roughly 10 credits per arm, so a
two-provider batch runs into the high hundreds of credits and takes a while.
Check `providers --check` first, and use `batch --per-type 1` (6 queries, one per
type) for a cheap sweep before committing to the full 48.
```

---

## MCP: the server agents should actually use

`sourcery mcp` serves the same engine over stdio. Register it once:

```json
{
  "mcpServers": {
    "sourcery": {
      "command": "npx",
      "args": ["-y", "sourcery-eval", "mcp"]
    }
  }
}
```

Claude Code: `claude mcp add sourcery -- npx -y sourcery-eval mcp`

Run the client from your project directory — the server resolves
`.sourcery/runs.jsonl` relative to its working directory, so from anywhere else
you get the shipped reference numbers instead of your own.

### `which_provider` — cheap, use this first
`{ query, model? }` → the provider that scored best on that kind of query, from
your own eval history. One LLM call to classify the query; no retrieval, no
provider calls.

`model` sets the classifier. It defaults to an OpenAI model, so pass this if your
key is from somewhere else.

Read `decided_by` before trusting the pick:

| value | meaning |
|---|---|
| `retrieval` | a genuine quality win — the gap cleared its confidence interval |
| `reliability` | quality was a statistical tie; the more dependable provider won |
| `inconclusive` | neither separates them. A coin flip. The pick is the better point estimate, nothing more |
| `unopposed` | only one provider has been run for this type — not evidence |

A `caveat` field means you got our reference numbers, not yours. Run
`sourcery batch` to replace them with measurements from your own queries.

### `evaluate_retrieval` — expensive, use it to settle things
`{ query, providers?, model? }` → runs the actual experiment and returns a
compact scorecard: per-provider retrieval and answer scores, errors, winner.
Makes live provider and LLM calls and costs credits. Reach for it when
`which_provider` says `inconclusive`, or when the recommendation needs proving on
a query that matters.

---

## The one thing worth understanding

Retrieval and answering fail differently, and most evals can't tell them apart —
a bad answer from good sources and a good answer from lucky parametric memory
look identical at the end of the pipeline. sourcery grades the sources
separately, with a judge that never sees the answer, on queries that all demand
current facts so training-data recall can't substitute for retrieval.

That's why `retrieval_score` is the number to act on, and why an agent that reads
only the answer score is measuring its model rather than its retrieval layer.
