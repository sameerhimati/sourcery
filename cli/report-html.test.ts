import { describe, expect, it } from "vitest";
import type { BatchRowRecord, RunRecord } from "./persist";
import { buildReport } from "./report-html";

const runRec: RunRecord = {
  mode: "run",
  id: "run_1",
  ts: "2026-07-23T00:00:00.000Z",
  query: 'H-1B <lottery> & "reform"?', // exercises HTML escaping
  variable: "provider",
  winner: "A",
  judge_model: "gpt-4o-mini",
  arms: [
    {
      id: "A",
      provider: "bright_data",
      config: { freshness: "all", num_sources: 8, extraction: "clean" },
      model: "gpt-4o-mini",
      answer: "a",
      sources: [
        {
          title: "USCIS <update>", // escaping in a source title too
          url: "https://uscis.gov/h1b",
          published: "2026-03-01",
          domain: "uscis.gov",
          content: "The H-1B registration process changed as follows…",
        },
      ],
      latency_ms: 1200,
      retrieval_score: 8,
      retrieval_rationale: "",
      score: 7,
      rationale: "",
    },
    {
      id: "B",
      provider: "firecrawl",
      config: { freshness: "all", num_sources: 8, extraction: "clean" },
      model: "gpt-4o-mini",
      answer: "",
      sources: [],
      latency_ms: 0,
      retrieval_score: 0,
      retrieval_rationale: "",
      score: 0,
      rationale: "",
      error: "FIRECRAWL_API_KEY missing",
    },
  ],
};

const batchRec = (retrieval: number, provider: "bright_data" | "firecrawl"): BatchRowRecord => ({
  mode: "batch",
  batchId: "batch_1",
  ts: "2026-07-23T00:05:00.000Z",
  row: {
    queryId: "bn-01",
    type: "breaking_news",
    query: "q",
    provider,
    retrieval_score: retrieval,
    answer_score: retrieval,
    retrieval_rationale: "",
    median_source_age_days: 30,
    num_sources: 8,
    num_sources_extracted: 8,
    latency_ms: 100,
  },
});

describe("buildReport", () => {
  it("renders runs + latest batch, escapes user text, marks the winner", () => {
    const html = buildReport(
      [runRec, batchRec(4, "bright_data"), batchRec(6, "firecrawl")],
      "2026-07-23T01:00:00.000Z",
    );

    expect(html).toContain("<!doctype html>");
    // Query text is HTML-escaped, never injected raw.
    expect(html).toContain("H-1B &lt;lottery&gt; &amp; &quot;reform&quot;?");
    expect(html).not.toContain("<lottery>");
    // Winner star + failed arm's error surfaced.
    expect(html).toContain("★ Bright Data");
    expect(html).toContain("FIRECRAWL_API_KEY missing");
    // Heatmap aggregates the batch by type/provider.
    expect(html).toContain("breaking news");
    expect(html).toContain("Firecrawl");
    // Retrieved sources are shown (collapsible) with their content, escaped.
    expect(html).toContain("1 source retrieved");
    expect(html).toContain("uscis.gov");
    expect(html).toContain("The H-1B registration process changed");
    expect(html).toContain("USCIS &lt;update&gt;");
    // Judge model surfaced in the run meta.
    expect(html).toContain("judge gpt-4o-mini");
  });

  it("shows an empty state when there are no records", () => {
    expect(buildReport([], "2026-07-23T01:00:00.000Z")).toContain("No runs yet");
  });
});
