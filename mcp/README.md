# sourcery for agents

> Your agent picks a web-search provider from measurements instead of a hardcoded default.

sourcery compares web-retrieval providers — Firecrawl, Tavily, Exa, Bright Data, a
keyless baseline — on **your** queries, with everything else held constant: same
answer model, same prompts, same judge. The MCP server puts that in reach of a
coding agent, so "which search API?" becomes a question with an answer instead of
a guess.

Nothing here is hosted. `sourcery mcp` speaks JSON-RPC over stdio; your client
spawns it as a child process and it dies with your session.

## Install

```bash
claude mcp add sourcery -- npx -y sourcery-eval mcp   # Claude Code
codex mcp add sourcery -- npx -y sourcery-eval mcp    # Codex
```

`npx sourcery-eval mcp --install` prints these plus the JSON form for Cursor and
Claude Desktop, and the `[mcp_servers.sourcery]` table for `~/.codex/config.toml`.

**Run your agent from your project directory.** The server resolves
`.sourcery/runs.jsonl` and `.env.local` relative to its working directory, which
is wherever the client was launched. From the wrong directory everything still
works — you just get the shipped reference numbers instead of your own, and every
response says so in a `caveat` field.

You need one LLM key (`GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or
`FIREWORKS_API_KEY`) in that `.env.local`. `which_provider` spends exactly one
call on it.

## The two tools

### `which_provider` — cheap, start here

`{ query, model? }` → the provider that scored best on this kind of query, from
this project's eval history. One LLM call to classify the query. No retrieval, no
provider calls, no credits.

```json
{
  "query": "what shipped in the OpenAI API this week",
  "type": "breaking_news",
  "provider": "firecrawl",
  "runner_up": "exa",
  "margin": 0.5,
  "decided_by": "inconclusive",
  "retrieval_mean": 4.5,
  "n_queries": 1,
  "error_rate": 0,
  "source": ".sourcery/runs.jsonl"
}
```

**Read `decided_by` before acting on `provider`.** It is the difference between
evidence and a coin flip:

| value | what it means |
|---|---|
| `retrieval` | a real quality win — the gap cleared its confidence interval |
| `reliability` | quality was a statistical tie; the more dependable provider won |
| `inconclusive` | neither separates them. The pick is the better point estimate, nothing more |
| `unopposed` | only one provider has been run for this type. Not evidence |

`model` sets the classifier. It defaults to an OpenAI model, so pass it if your
key is from anywhere else — e.g. `groq/llama-3.3-70b-versatile`.

### `evaluate_retrieval` — expensive, use it to settle things

`{ query, providers?, model? }` → runs the actual experiment and returns
per-provider retrieval and answer scores with a winner. Makes live provider and
LLM calls, and spends credits.

Reach for it when `which_provider` says `inconclusive`, or when a recommendation
needs proving on a query that actually matters.

The judge is deliberately not overridable here. The anti-cheat depends on a judge
whose training cutoff predates the queries, and letting an agent swap it would
quietly invalidate every number it returns.

## Reading the scores

- **`retrieval_score` (0–10) is the primary number.** It grades the *sources* —
  fresh? on-topic? actually extracted? — with a judge that never sees the answer.
- **`answer_score` (0–10) is secondary.** Trust it less: the answer judge can
  penalise a correct answer about events after its own training cutoff.
- **Always read the error field.** Arms never throw; a failure is recorded, not
  hidden. A provider scoring slightly higher while failing a quarter of its calls
  is the worse choice.

The two barely relate — across the full 48-query set they correlate at **r =
0.16**. A provider can return stale, half-extracted junk and the answer built on
it still reads well, because the model is answering from what it already knew.
**Grade a search API on the answer downstream of it and you are mostly grading
your own model.** That is why there are two scores, and why the source one is the
one to act on. Worked examples in [`docs/findings.md`](../docs/findings.md).

## Make the numbers yours

Out of the box you get reference numbers measured on this project's own 48-query
set, flagged with a `caveat`. They are a floor, not the goal — the queries that
matter are yours.

```bash
sourcery batch --per-type 4 --providers tavily,exa   # a cheap first pass
sourcery batch --dry-run                             # price the full set first
```

Every run appends to `.sourcery/runs.jsonl`, and `which_provider` prefers your
data over the shipped numbers the moment it covers a type.

## Paste-in instructions for an agent

[`docs/agent-prompt.md`](../docs/agent-prompt.md) is a block written to be dropped
straight into a `CLAUDE.md`, an `AGENTS.md`, a system prompt, or a skill. It
covers the CLI surface as well, for agents that would rather shell out than speak
MCP.

Tool definitions are in [`server.ts`](server.ts).
