# Session Handoff — Sourcery
> Last updated: 2026-07-07 (hackathon, evening — session 2 end)

Sourcery = a **retrieval eval harness**. Same query → several web-search "arms" that differ ONLY in
their retrieval backend/config (Bright Data vs Firecrawl, or config within one) → same model + prompt
+ judge → LLM judge scores each → side-by-side grid picks a winner. Thesis: *everyone evals the model;
nobody evals the retrieval.* Hold model/prompt/judge constant, vary only the fetch.

## Completed So Far
- [x] Working, reliable backend MVP: adapters (`brightdata.ts`/`firecrawl.ts`, one interface), `answer.ts` +
      `judge.ts` (gpt-4o-mini, held constant), `orchestrator.ts` (parallel arms), `api/run/route.ts`. `tsc` clean.
- [x] Data Contract in `src/lib/types.ts` (`Run`/`Arm`/`Source`). All 3 deps validated LIVE. Zone `sourcery_serp` created.
- [x] Verified end-to-end: 3/3 runs, both arms return 8 sources, judge scores, winner highlighted.
- [x] Placeholder UI stub at `src/app/page.tsx` — **to be replaced by the designer's design (below).**
- [x] **Designer's design received + assessed.** The `example.com` file on the Desktop was a mis-named ZIP =
      the full design export. Extracted into `design/sourcery-benchmark-harness-.../project/`:
      **`Sourcery.dc.html`** (28 KB clean source — USE THIS, not the 333 KB `~/Desktop/Sourcery.html` bundle),
      `support.js`, `README.md`, and `screenshots/` (01/02/03-current + heatmap).

## Design assessment (verdict: strong — port it, then improve)
- Two tabs: **Comparison** and **Scorecard** (the heatmap). Header: "Evals for the retrieval layer, not the model."
- Comparison: provider columns, `Winner` badge + card glow, large score badge (red→green oklch gradient) +
  progress bar, judge rationale blockquote, answer, expandable **"Sources"** list (freshness dots, domain ·
  published · age, ↗). Meta line `{freshness} · {extraction} · {latency}s`. Top: query box + `vary` toggle
  (Provider / Freshness) + `Run`. A client-side **VERDICT banner** (winner + margin + one-line reason).
- Scorecard: "Win/loss scorecard — average judge score by query type. Neither provider wins everything."
  query type × provider heatmap, oklch color scale, per-row winner ring, avg+wins footer, "24 runs per cell."
- **Two caveats found in code review:**
  1. **Theme mismatch to reconcile:** the zip's screenshots are DARK, but the standalone bundled
     `~/Desktop/Sourcery.html` renders LIGHT/beige (`#e9e5dc`). Treat the zip's `Sourcery.dc.html` +
     its screenshots as the source of truth; confirm intended theme with the designer.
  2. **It's a STATIC mockup, and NOT React** — built in Claude's DC declarative-template format
     (`sc-if`/`sc-for`/`{{ }}`, `DCLogic`/`setState`), hardcoded `const RUN`/`const HEAT`, "Run" just fakes
     a `setTimeout` load. Must be HAND-TRANSLATED to JSX (~1–2h mechanical). Pure helpers (score/heat color
     via oklch, age formatting) copy directly. Fonts: Space Grotesk + IBM Plex Mono → swap for `next/font`.

## Next Session Should  (USE SUBAGENTS LIBERALLY; do it in PLAN MODE — multi-file change)
1. **Opening gambit — port the design into React.** Read `design/sourcery-benchmark-harness-.../project/
   Sourcery.dc.html` (clean source) and hand-translate its DC template to JSX in `src/app/page.tsx`, wired to
   the EXISTING `/api/run` (design's `RUN` is hardcoded — replace the fake `setTimeout` with a real fetch).
   Comparison view first (near drop-in). Contract-mapping gaps the design misses — fix while porting:
   **no error-state card** (`Arm.error` unrendered), **`Source.snippet` dropped**, **`vary` toggle exposes
   only provider/freshness** (add num_sources/extraction if driving `variable`), **grid hardcoded to 2 arms**
   (map over `arms.length`). NOTE: repo `AGENTS.md` warns this Next.js has breaking changes — read
   `node_modules/next/dist/docs/` before writing Next code.
2. **Make it better where the design is thin (the user's priorities):**
   - **Maximum observability** — design only has the "audit fetched pages" hook; build the deep panel:
     shared answer system prompt + judge rubric ("held constant" controls), exact `context` string per arm,
     judge's raw input (answer + source list) + raw JSON verdict, per-step latency, token counts. Requires
     **extending the Data Contract** (`src/lib/types.ts`) — lock the shape first (designer boundary). Prompts
     live as `SYSTEM` consts in `answer.ts`/`judge.ts`; expose via a top-level `controls` block and/or per-arm `trace`.
   - Surface numeric **score + judge rationale** on Comparison cards (design only shows WINNER).
3. **Heatmap needs data the backend can't produce yet:** "24 runs per cell" × 4 query types = a **batch eval
   set + batch endpoint**. Today `/api/run` is single-query/single-run. Build a batch runner, or seed the
   heatmap from precomputed results for the demo. Decide priority vs observability.
4. `git init` + first commit. Harden Bright Data reliability if it flakes live.

## Context to Remember (hard-won)
- **Keys** (`.env.local`): `OPENAI_API_KEY`, `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_SERP_ZONE=sourcery_serp`,
  `FIRECRAWL_API_KEY`. Model = `gpt-4o-mini` (`llm.ts`). `.env` changes need a dev restart.
- **Design is fully on disk now** — no `/design-login` needed. (The claude.ai Design MCP `DesignSync` is
  auth-gated behind `/design-login`; the shared project isn't in the user's writable list. Moot now.)
- **Bright Data SERP recipe** (empirically correct; research doc was partly wrong): `POST
  https://api.brightdata.com/request`, body `{zone, country:"us", url, format:"raw"}`, Google URL carries
  `&gl=us&hl=en&brd_json=1`. `format:"json"` = HTTP envelope w/ raw HTML (NOT parsed). `brd_json=1` = parse
  switch; `format:"raw"` → body is parsed SERP JSON (`{general, organic:[{link,title,description}]}`). `num`
  REJECTED (slice in code). Missing `gl=us`+`country:us` → random proxy exit (saw Taiwan → empty results).
- **Flakiness:** same query returns 10 organic then 0; `tbs` freshness filter worsens empties. Hence
  `DEFAULT_CONFIG.freshness="all"` + 5x retry w/ 500ms backoff in `brightdata.ts`.
- **Zone creation via API:** `POST https://api.brightdata.com/zone` `{"zone":{"name":"sourcery_serp","type":
  "serp"},"plan":{"type":"unblocker","serp":true}}`. Drop `custom_headers`. Free tier 5k credits/mo.
- **Firecrawl:** v2 `POST https://api.firecrawl.dev/v2/search`, body `{query, limit, tbs?}` (camelCase),
  results `data.web[]` (`title/url/description`). No per-result date → `published:null`. 1000 credits/mo.
- **Demo beat:** the judge caught a hallucinated future effective-date and docked the score — grader has teeth.

## Start Command
```bash
cd /Users/sameer/Code/SideProjects/sourcery && npm run dev
# open http://localhost:3000  ·  or test the engine directly:
curl -sS -X POST http://localhost:3000/api/run -H 'content-type: application/json' \
  -d '{"query":"What are the newest changes to the H-1B visa lottery?"}'
```
