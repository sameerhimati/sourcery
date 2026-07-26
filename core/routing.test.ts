import { describe, expect, it } from "vitest";
import type { BatchRowRecord, SourceryRecord } from "./records";
import type { QueryType } from "./eval-dataset";
import { bestPerType, bestProviderByType } from "./routing";

function batchRow(
  queryId: string,
  type: QueryType,
  provider: string,
  retrieval: number,
  answer: number,
  error?: string,
): BatchRowRecord {
  return {
    mode: "batch",
    batchId: "b1",
    ts: "2026-07-24T00:00:00.000Z",
    row: {
      queryId,
      type,
      query: `query ${queryId}`,
      provider,
      retrieval_score: retrieval,
      answer_score: answer,
      retrieval_rationale: "",
      median_source_age_days: null,
      num_sources: 5,
      num_sources_extracted: 5,
      latency_ms: 100,
      ...(error ? { error } : {}),
    },
  };
}

describe("bestProviderByType", () => {
  it("ranks providers per type on retrieval score and reports the margin", () => {
    const records: SourceryRecord[] = [
      batchRow("bn-01", "breaking_news", "firecrawl", 8, 7),
      batchRow("bn-02", "breaking_news", "firecrawl", 6, 7),
      batchRow("bn-01", "breaking_news", "bright_data", 4, 9),
      batchRow("bn-02", "breaking_news", "bright_data", 4, 9),
      batchRow("ht-01", "how_to", "bright_data", 9, 9),
      batchRow("ht-01", "how_to", "firecrawl", 3, 3),
    ];

    expect(bestProviderByType(records)).toEqual([
      {
        type: "breaking_news",
        provider: "firecrawl",
        retrieval_mean: 7,
        answer_mean: 7,
        n_queries: 2,
        runner_up: "bright_data",
        margin: 3,
      },
      {
        type: "how_to",
        provider: "bright_data",
        retrieval_mean: 9,
        answer_mean: 9,
        n_queries: 1,
        runner_up: "firecrawl",
        margin: 6,
      },
    ]);
  });

  it("ignores errored rows and run records — neither can support a recommendation", () => {
    const records: SourceryRecord[] = [
      batchRow("bn-01", "breaking_news", "firecrawl", 8, 8),
      batchRow("bn-02", "breaking_news", "firecrawl", 0, 0, "429 rate limited"),
      {
        mode: "run",
        id: "run_x",
        ts: "2026-07-24T00:00:00.000Z",
        query: "an untyped one-off query",
        variable: "provider",
        winner: "A",
        judge_model: "gpt-4o-mini",
        arms: [],
      },
    ];

    expect(bestProviderByType(records)).toEqual([
      {
        type: "breaking_news",
        provider: "firecrawl",
        retrieval_mean: 8, // the failed arm's 0 must not halve this
        answer_mean: 8,
        n_queries: 1,
        runner_up: null, // nothing was compared against it
        margin: 0,
      },
    ]);
  });

  it("counts distinct queries, not rows, so a repeated batch is not new evidence", () => {
    const records = [
      batchRow("bn-01", "breaking_news", "firecrawl", 8, 8),
      batchRow("bn-01", "breaking_news", "firecrawl", 6, 6),
    ];
    expect(bestProviderByType(records)[0]).toMatchObject({ n_queries: 1, retrieval_mean: 7 });
  });
});

describe("bestPerType", () => {
  it("breaks a retrieval tie on answer score, then on provider id", () => {
    const [top] = bestPerType([
      { type: "numeric_live", provider: "zzz", retrieval_mean: 5, answer_mean: 5, n_queries: 8 },
      { type: "numeric_live", provider: "aaa", retrieval_mean: 5, answer_mean: 5, n_queries: 8 },
      { type: "numeric_live", provider: "mid", retrieval_mean: 5, answer_mean: 6, n_queries: 8 },
    ]);
    expect(top.provider).toBe("mid");
    expect(top.runner_up).toBe("aaa");
  });
});
