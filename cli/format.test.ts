import { describe, expect, it } from "vitest";
import type { Arm, Run } from "@core/types";
import type { BatchOutput } from "@core/batch";
import { renderBatch, renderRun } from "./format";

function arm(over: Partial<Arm>): Arm {
  return {
    id: "A",
    provider: "bright_data",
    config: { freshness: "all", num_sources: 8, extraction: "clean" },
    model: "gpt-4o-mini",
    answer: "answer",
    sources: [],
    latency_ms: 1200,
    retrieval_score: 7,
    retrieval_rationale: "",
    score: 6,
    rationale: "",
    ...over,
  };
}

describe("renderRun", () => {
  it("renders an aligned scorecard, marks the winner, shows errors", () => {
    const run: Run = {
      query: "what changed in the H-1B lottery?",
      variable: "provider",
      winner: "A",
      arms: [
        arm({ id: "A", provider: "bright_data", retrieval_score: 7, score: 6 }),
        arm({
          id: "B",
          provider: "firecrawl",
          error: "FIRECRAWL_API_KEY missing",
        }),
      ],
    };

    expect(renderRun(run)).toMatchInlineSnapshot(`
      "Query: what changed in the H-1B lottery?
      Varying: provider

         ARM  PROVIDER     RETRIEVAL  ANSWER  LATENCY
       ★ A    Bright Data  7/10       6/10    1200ms 
         B    Firecrawl    —          —       —         (FIRECRAWL_API_KEY missing)

      Winner: A (Bright Data) — retrieval 7/10"
    `);
  });

  it("reports no winner when all arms failed", () => {
    const run: Run = {
      query: "q",
      variable: "provider",
      winner: null,
      arms: [arm({ id: "A", error: "boom" })],
    };
    expect(renderRun(run)).toContain("Winner: none (all arms failed)");
  });
});

describe("renderBatch", () => {
  it("renders the provider heatmap with the per-type leader", () => {
    const out: BatchOutput = {
      generated_at: "2026-07-23T00:00:00.000Z",
      runs_per_cell: 1,
      rows: [], // rows not shown in the summary; only the aggregated heatmap is
      heatmap: [
        { type: "breaking_news", label: "breaking news", bright_data: 3.2, firecrawl: 4.1, runs: 1 },
        { type: "how_to", label: "how-to / explainer", bright_data: 6.5, firecrawl: 6.5, runs: 1 },
      ],
    };
    expect(renderBatch(out)).toMatchInlineSnapshot(`
      "Batch — 0 arms, 1 run(s)/cell
      Generated: 2026-07-23T00:00:00.000Z
      avg retrieval score (0–10) by query type:

        TYPE                BRIGHT DATA  FIRECRAWL  LEADS
        breaking news       3.2          4.1        Firecrawl
        how-to / explainer  6.5          6.5      "
    `);
  });
});
