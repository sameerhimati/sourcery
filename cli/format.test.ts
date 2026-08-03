import { describe, expect, it } from "vitest";
import type { Arm, Run } from "@core/types";
import type { BatchOutput } from "@core/batch";
import { renderBatch, renderCredibility, renderRun } from "./format";

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
      judge_model: "gpt-4o-mini",
      arms: [
        arm({
          id: "A",
          provider: "bright_data",
          retrieval_score: 7,
          score: 6,
          sources: [
            { title: "t", url: "https://a.com/x", published: "2025-01-01", domain: "a.com" },
          ],
        }),
        arm({
          id: "B",
          provider: "firecrawl",
          error: "FIRECRAWL_API_KEY missing",
        }),
      ],
    };

    expect(renderRun(run)).toMatchInlineSnapshot(`
      "Query: what changed in the H-1B lottery?
      Varying: provider  ·  Judge: gpt-4o-mini

         ARM  PROVIDER     RETRIEVAL  ANSWER  LATENCY
       ★ A    Bright Data  7/10       6/10    1200ms 
         B    Firecrawl    —          —       —         (FIRECRAWL_API_KEY missing)

      Winner: A (Bright Data) — retrieval 7/10

      Sources:
        A (Bright Data): a.com"
    `);
  });

  it("reports no winner when every provider failed", () => {
    const run: Run = {
      query: "q",
      variable: "provider",
      winner: null,
      judge_model: "gpt-4o-mini",
      arms: [arm({ id: "A", error: "boom" })],
    };
    expect(renderRun(run)).toContain("Winner: none (every provider failed)");
  });
});

describe("renderBatch", () => {
  it("renders the provider heatmap with the per-type leader", () => {
    const out: BatchOutput = {
      generated_at: "2026-07-23T00:00:00.000Z",
      runs_per_cell: 1,
      providers: ["bright_data", "firecrawl"],
      rows: [], // rows not shown in the summary; only the aggregated heatmap is
      heatmap: [
        {
          type: "breaking_news",
          label: "breaking news",
          scores: { bright_data: 3.2, firecrawl: 4.1 },
          runs: 1,
        },
        {
          type: "how_to",
          label: "how-to / explainer",
          scores: { bright_data: 6.5, firecrawl: 6.5 },
          runs: 1,
        },
      ],
    };
    expect(renderBatch(out)).toMatchInlineSnapshot(`
      "Batch — 0 arms, 1 run(s)/cell
      Generated: 2026-07-23T00:00:00.000Z
      avg retrieval score (0–10) by query type:

        TYPE                BRIGHT DATA  FIRECRAWL  LEADS
        breaking news       3.2          4.1        too close to call
        how-to / explainer  6.5          6.5      

      1 run per cell: re-running the same query moves this score by ~1.0
      on its own, so treat single-run gaps as a hint about where to look, not a result."
    `);
  });

  it("widens to however many providers ran, and names the single leader", () => {
    const out: BatchOutput = {
      generated_at: "2026-07-29T00:00:00.000Z",
      runs_per_cell: 2,
      providers: ["firecrawl", "tavily", "exa"],
      rows: [],
      heatmap: [
        {
          type: "breaking_news",
          label: "breaking news",
          scores: { firecrawl: 2.5, tavily: 3.0, exa: 7.0 },
          runs: 2,
        },
        // A three-way tie at the top must print no leader: naming one of them
        // would report a clean win that the numbers don't show.
        {
          type: "how_to",
          label: "how-to / explainer",
          scores: { firecrawl: 5.0, tavily: 5.0, exa: 5.0 },
          runs: 2,
        },
      ],
    };
    expect(renderBatch(out)).toMatchInlineSnapshot(`
      "Batch — 0 arms, 2 run(s)/cell
      Generated: 2026-07-29T00:00:00.000Z
      avg retrieval score (0–10) by query type:

        TYPE                FIRECRAWL  TAVILY  EXA  LEADS
        breaking news       2.5        3.0     7.0  Exa
        how-to / explainer  5.0        5.0     5.0
      "
    `);
  });
});

describe("renderBatch: the noise floor", () => {
  // SEED_NOISE (1.04) is measured: re-running the same query against the same
  // provider moves retrieval_score by that much on its own. So a smaller gap is
  // not a lead. The old table named a winner on a 0.9 gap while the
  // "1 run(s)/cell" caption did all the hedging — the exact error the 480-arm
  // run exists to catch, committed by the tool that reported it.
  const out = (a: number, b: number, runs = 1): BatchOutput => ({
    generated_at: "2026-07-29T00:00:00.000Z",
    runs_per_cell: runs,
    providers: ["firecrawl", "tavily"],
    rows: [],
    heatmap: [
      { type: "breaking_news", label: "breaking news", scores: { firecrawl: a, tavily: b }, runs },
    ],
  });

  it("names no leader when the gap is under the noise floor", () => {
    const t = renderBatch(out(4.1, 3.2)); // gap 0.9
    expect(t).toContain("too close to call");
    expect(t).not.toContain("Firecrawl\n");
  });

  it("names the leader once the gap clears the noise floor", () => {
    expect(renderBatch(out(5.0, 3.2))).toMatch(/3\.2 +Firecrawl/); // gap 1.8
  });

  it("treats a gap exactly at the floor as real", () => {
    expect(renderBatch(out(4.24, 3.2))).toMatch(/Firecrawl/); // gap 1.04
  });

  it("says nothing on an exact tie — not 'too close', which implies a near-winner", () => {
    const t = renderBatch(out(5.0, 5.0));
    expect(t).not.toContain("too close");
    expect(t).not.toContain("Firecrawl  ");
  });

  it("warns about single-run cells, and stops once there are repeats", () => {
    expect(renderBatch(out(5.0, 3.2, 1))).toContain("1 run per cell");
    expect(renderBatch(out(5.0, 3.2, 5))).not.toContain("1 run per cell");
  });
});

describe("renderCredibility: unparseable judge verdicts", () => {
  const base = {
    generated_at: "2026-07-24T00:00:00.000Z",
    seeds: 2,
    answer_model: "m",
    judges: ["prov/jA"],
    n_rows: 4,
    n_errors: 0,
    providers: ["bright_data"],
    n_queries: 2,
    by_provider: [{
      provider: "bright_data", n_queries: 2,
      retrieval_mean: 5, retrieval_ci95: 1, answer_mean: 5, answer_ci95: 1,
      // 2 queries × 2 seeds, none failed — consistent with n_rows/n_errors above.
      n_arms: 4, n_errors: 0, error_rate: 0,
    }],
    by_type: [],
    agreement: [],
    variance: { seed_std_mean: 0, judge_gap_mean: 0 },
  };

  it("stays quiet when every verdict parsed", () => {
    const out = renderCredibility({ ...base, n_unparseable_judgements: 0 });
    expect(out).not.toContain("unparseable");
    // and reports the real shape rather than a hardcoded one
    expect(out).toContain("2 queries × Bright Data × 2 seeds");
  });

  it("warns loudly that unparseable verdicts are not genuine zeros", () => {
    const out = renderCredibility({ ...base, n_unparseable_judgements: 3 });
    expect(out).toContain("3 judge verdict(s) were unparseable");
    expect(out).toContain("NOT genuine zeros");
  });
});
