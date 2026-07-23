# sourcery — rebuild plan: from hackathon dashboard to a dev tool

> Plan of record, 2026-07-23. Written after the Bean rebuild-planning session; same method:
> name the durable core, kill the incidental shell, sequence with verifiable gates.
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
agents like Bean) who is currently choosing a provider on vibes. The pitch: *"eval your
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
- **S4 — Publish.** Fresh repo, npm name claimed, README-as-launch-post, Show HN / PH.
  Gate: `npx <name> run` works from a clean machine that has never seen the repo.

## Explicitly NOT in scope

- Crawling (that's Bean's M2 problem; sourcery evals *search* retrieval — Bean borrows
  `unlock()`/`cleanMarkdown()` as parts, the projects stay separate).
- Hosted anything. No accounts, no server, no telemetry. Local files only.
- A prettier dashboard before S2 — the terminal + HTML report are the product surface now.
