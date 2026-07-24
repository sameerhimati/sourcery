# sourcery — rebuild plan: from hackathon dashboard to a dev tool

> Plan of record, 2026-07-23. Method: name the durable core, kill the incidental shell,
> sequence with verifiable gates.
> Target: open source, PostHog-seamless — a dev adds retrieval evals to their project with
> **one command**, the way they'd add analytics.

## The reframe

The hackathon built a **dashboard app**. The useful product is a **CLI + library** with the
dashboard demoted to an optional report viewer.

What's durable (the actual IP, all already written and working):
- The **harness discipline**: same query → arms that differ ONLY in retrieval → same answer
  model + prompt + judge. Nobody evals the retrieval layer; everybody evals the model.
- The **stale-judge trick**: a judge with an old cutoff + queries that demand *latest/current*
  makes parametric-memory cheating structurally impossible (`src/lib/eval-dataset.ts`).
- The **two-score split**: `retrieval_score` vs `answer_score` — retrieval and answering fail
  differently, and you need to see which half broke (`judge.ts`, `retrievalJudge.ts`).
- The **non-rotting dataset**: 48 queries, 6 types, phrased "latest/newest" so it stays valid
  as the world moves.
- A real finding with teeth (README): more extracted context → *worse* answers; both providers
  return ~year-old sources for "latest" queries.

What's incidental: Next.js, the tabs, the in-memory-only results, the two hardcoded providers.

**Who it's for:** anyone building on web retrieval (RAG apps, research agents, crawler-fed
agents) who is currently choosing a provider on vibes. The pitch: *"eval your
retrieval layer on YOUR queries in one command."*

## Target developer experience

```bash
npx sourcery init          # scaffolds sourcery.config.ts + .env.example, detects keys
npx sourcery run "what changed in the H-1B lottery?"   # one query, all configured arms, terminal scorecard
npx sourcery batch         # built-in 48-query set (or --queries my-queries.jsonl)
npx sourcery report        # opens the self-contained HTML report for the last batch
```

- Results persist to `.sourcery/runs.jsonl` (today nothing is written to disk — a batch dies
  with the process). The JSONL is the contract; terminal table and HTML report are views.
- BYO keys, BYO judge (judge model configurable; OpenAI today, Anthropic adapter next — the
  judge is already isolated in `llm.ts`).
- Custom queries in, custom providers in: the two extension points ARE the product surface.

## Component decomposition

1. **`core/`** — extract from the Next app, zero behavior change: `types.ts` (the Run/Arm/Source
   contract — already clean), `orchestrator.ts`, `adapters/*`, `answer.ts`, `judge.ts`,
   `retrievalJudge.ts`, `eval-dataset.ts`, `extract.ts`. No Next imports allowed in `core/`.
2. **`cli/`** — thin commander over core: `init | run | batch | report`. Reads
   `sourcery.config.ts` + env. Writes `.sourcery/runs.jsonl` + `report.html` (self-contained,
   inline CSS/JS — reuse the oklch score-color helpers from the dashboard port).
3. **Adapters** — keep Bright Data + Firecrawl; add `plain-fetch` (the free baseline every
   comparison needs), then Tavily and Exa. The adapter interface (`adapters/index.ts`) is
   already the right seam; write the "author an adapter in <100 lines" guide — that's the
   community hook.
4. **Dashboard** — the existing Next app stays as the optional viewer, reading `runs.jsonl`
   instead of holding results in memory. Not the install path; never required.

## Scientific hardening (the credibility milestone)

The README already confesses the limits: n=12, single run, one judge, no CIs, no inter-judge
agreement. Before any launch, run what the README promises: **full 48 queries × 3 seeds ×
2 judge models**, report confidence intervals and judge agreement, update the findings table.
A tool whose own headline eval is underpowered can't tell other people to eval their stack.

## Open-source path (mirrors Bean's, easier)

- **Fresh public repo, no history** (Sameer's call — he'll work from a new repo). Nothing
  sensitive was ever committed (keys live only in untracked `.env.local`), but fresh history
  is free and clean. **Rotate all three keys in `.env.local` first** — they're live.
- Add the missing **`.env.example`** (README references it; it doesn't exist), MIT license,
  and tests (currently ZERO): contract validation, adapter tests against recorded fixtures,
  one live smoke behind an env flag.
- **Naming check before publish:** "sourcery" collides with sourcery.ai (established Python
  dev tool) — likely npm-squatted too. Decide at S4: keep the working name locally, pick the
  published name (`sourcery-evals`, `retrieval-sourcery`, `srcry`?) when claiming npm.
- Hard-won provider knowledge in the handoff (Bright Data zone recipe, flakiness retries,
  Firecrawl v2 quirks) graduates into `docs/providers.md` — it's half the value to a stranger.

## Milestones — each with a gate

- **S0 — Extract core.** Move the engine out of the Next app into `core/` with no behavior
  change; the app imports from core. Gate: `tsc` clean + one recorded-fixture test proves a
  run produces an identical Run object before/after.
- **S1 — CLI MVP.** `init/run/batch/report`, JSONL persistence, terminal scorecard,
  self-contained HTML report, `.env.example`. Gate: fresh clone → `npm i` → `npx sourcery run
  "…"` works with only keys set; batch survives process restart (results on disk).
- **S2 — Credibility run.** 48 × 3 seeds × 2 judges, CIs, judge agreement; README findings
  rewritten on the stronger data. Gate: the "what I wouldn't defend" list measurably shrinks.
- **S3 — Adapter ecosystem.** plain-fetch baseline + Tavily + Exa + authoring guide.
  Gate: a new adapter lands in <100 lines without touching core.
  **Done 2026-07-24. Gate met:** Tavily 84 lines, Exa 83, each a self-contained file
  plus a 7-line registry entry — no core logic touched, because `Provider` became an
  open type over a registry rather than a closed union. Guide: `docs/providers.md`.
  Caveat: Tavily and Exa are written to their published API shapes but have **never
  run live** (no keys); `plain` is verified only as far as its SERP parse.
- **S4 — Publish.** Fresh repo, npm name claimed, README-as-launch-post, Show HN / PH.
  Gate: `npx <name> run` works from a clean machine that has never seen the repo.
  **Launch asset — an agent prompt (SKILL.md-style).** Agents are a real audience;
  ship a copy-pasteable block that teaches one how to use the tool (Firecrawl ships
  the same). Draft in [Launch: the agent prompt](#launch-the-agent-prompt) below.

## Where this could go: from eval to router (post-S4, the retention answer)

An eval you run once is a report; an eval that emits a production artifact is infrastructure.
The Scorecard already shows per-query-TYPE differences between providers (both collapse on
`breaking_news`; each wins elsewhere). If those differences are stable across seeds (S2 tells
us), then `sourcery route` can compile YOUR eval results into a routing policy — a tiny
exported `pickProvider(query)` (classify query type → best provider from your own scorecard)
that lives in your app. Offline eval → static routing table first; a live bandit (route,
judge async, update) only if the static table proves out. This is what makes the tool
*solve a problem* rather than describe one: your eval becomes your config. Not planned in
S0–S4; recorded so the contract (per-type scores in `runs.jsonl`) keeps it possible.

**S5 shape — MCP is the interface, the router is the capability (decided worth exploring
2026-07-24).** Not "MCP *instead of* router" — a routing decision is a natural MCP tool, so
MCP is likely the *right form* for the router, because agents are the actual users and MCP is
how you reach them (Firecrawl ships an MCP server for exactly this). A spectrum, ascending in
ambition and in "platform" risk:
1. **Eval-as-a-tool** — `evaluate_retrieval(queries)`: an agent audits its *own* retrieval.
   Thin wrapper over the existing `run`/`batch` functions. ~a day.
2. **Routing-decision tool** — `which_provider(query)` → best backend from your eval data.
   The router, expressed as MCP; cleaner than a static exported table.
3. **Live routing proxy** — `search(query)` and sourcery routes under the hood. Now it's a
   meta-provider service (latency, cost, key mgmt, fresh eval data) — the fullest "I built a
   platform" version, and the one that most dilutes the sharp "I eval retrieval" story.

Recommendation: scope S5 as (1)+(2) — both MCP-native, both thin, both keep the eval identity.
Hold (3) as a stretch; don't let S5 become a hosted service before S4 ships. MCP is additive
on top of a working CLI, never a prerequisite for launch.

## Launch: the agent prompt

An S4 asset — the SKILL.md-style block people paste into their agent so it knows how to drive
sourcery. Draft (refine against the real command surface at S4):

```markdown
# Using sourcery to evaluate web retrieval

sourcery compares web-retrieval providers on YOUR queries with YOUR model, so you
can pick the retrieval backend that actually works for your task instead of guessing.

## When to reach for it
- Building RAG or a research agent and haven't validated your retrieval provider.
- Answers are stale or wrong and you suspect retrieval, not the model.
- Choosing between Firecrawl / Tavily / Exa / Bright Data / a keyless baseline.

## Commands
- `sourcery providers --check`              list providers; are keys + quota live?
- `sourcery run "<query>" --values a,b`     one query, providers side by side, scored
- `sourcery batch`                          the full eval set → per-type heatmap
- `sourcery report`                         self-contained HTML from the run log

Bring your own model: `--model <provider>/<model>` (any OpenAI-compatible backend).

## How to read the output
- retrieval_score (0–10) is PRIMARY — it grades the fetched SOURCES (fresh? on-topic?
  real?), not the answer. This is the number to trust.
- answer_score (0–10) is secondary — the answer built from those sources.
- The winner is the highest retrieval_score among arms that DIDN'T error. Always
  check the error column: a provider that fails often is worse than one that scores
  slightly lower but always returns.
```

**The other half of the loop: capture, so the eval set is YOUR traffic.** A one-line wrapper
around the app's retrieval call (`sourcery.wrap(provider)`) logs every real query to
`.sourcery/queries.jsonl`; the eval then replays a clustered/deduped sample of *your agent's
actual searches* across providers instead of (only) the curated 48. That's the true
PostHog moment — instrumentation first, insight from your own traffic — and it turns a
run-once report into a standing loop: capture always-on → periodic eval on fresh samples →
routing table refreshed. One honest wrinkle to solve when this gets built: the stale-judge
anti-cheat trick assumes freshness-demanding queries, and real traffic isn't all like that —
captured queries need classification, with `retrieval_score` (source quality) carrying more
weight than `answer_score` where the judge could answer from memory. Local files only, as
ever: captured queries can contain user data and never leave the machine.

## Explicitly NOT in scope

- Crawling — sourcery evals *search* retrieval, not site crawling.
- Hosted anything. No accounts, no server, no telemetry. Local files only.
- A prettier dashboard before S2 — the terminal + HTML report are the product surface now.
