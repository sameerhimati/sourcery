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

    // Two queries per cell puts the t-based CI in the double digits, so neither
    // cell can claim a quality win. Both fall through to reliability, tie at a
    // 0% error rate, and land on "inconclusive" — which is the honest reading of
    // a two-query sample, and exactly what the picker used to hide.
    expect(bestProviderByType(records)).toEqual([
      {
        type: "breaking_news",
        provider: "firecrawl",
        retrieval_mean: 7,
        retrieval_ci95: 12.71,
        answer_mean: 7,
        n_queries: 2,
        error_rate: 0,
        runner_up: "bright_data",
        margin: 3,
        decided_by: "inconclusive",
      },
      {
        type: "how_to",
        provider: "bright_data",
        retrieval_mean: 9,
        retrieval_ci95: Infinity, // a single sample has no measurable interval
        answer_mean: 9,
        n_queries: 1,
        error_rate: 0,
        runner_up: "firecrawl",
        margin: 6,
        decided_by: "inconclusive",
      },
    ]);
  });

  it("prefers the reliable provider when the quality gap is inside the noise", () => {
    // firecrawl scores marginally higher, bright_data fails a third of its arms.
    // Scoring alone would hand this to firecrawl for the wrong reason; the point
    // is that it wins on never failing, and that the answer says which it was.
    const records: SourceryRecord[] = [
      batchRow("nl-01", "numeric_live", "firecrawl", 5, 5),
      batchRow("nl-02", "numeric_live", "firecrawl", 5, 5),
      batchRow("nl-03", "numeric_live", "firecrawl", 5, 5),
      batchRow("nl-01", "numeric_live", "bright_data", 5, 9),
      batchRow("nl-02", "numeric_live", "bright_data", 5, 9),
      batchRow("nl-03", "numeric_live", "bright_data", 0, 0, "bad proxy exit"),
    ];

    const [pick] = bestProviderByType(records);
    expect(pick).toMatchObject({
      provider: "firecrawl",
      decided_by: "reliability",
      error_rate: 0,
      runner_up: "bright_data",
    });
  });

  it("still reports a quality win when the gap clears its own interval", () => {
    // Tight, consistent scores 6 points apart: a real difference, not noise.
    const records: SourceryRecord[] = [
      batchRow("ht-01", "how_to", "firecrawl", 9, 9),
      batchRow("ht-02", "how_to", "firecrawl", 9, 9),
      batchRow("ht-03", "how_to", "firecrawl", 9, 9),
      batchRow("ht-01", "how_to", "bright_data", 3, 3),
      batchRow("ht-02", "how_to", "bright_data", 3, 3),
      batchRow("ht-03", "how_to", "bright_data", 3, 3),
    ];

    expect(bestProviderByType(records)[0]).toMatchObject({
      provider: "firecrawl",
      decided_by: "retrieval",
      margin: 6,
    });
  });

  it("keeps a failed arm out of the mean but counts it against reliability", () => {
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
        retrieval_ci95: Infinity,
        answer_mean: 8,
        n_queries: 1,
        error_rate: 0.5, // ...but it must not vanish either: 1 of 2 arms failed
        runner_up: null, // nothing was compared against it
        margin: 0,
        decided_by: "unopposed",
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
  const cell = (provider: string, retrieval: number, answer: number, error_rate = 0) => ({
    type: "numeric_live" as QueryType,
    provider,
    retrieval_mean: retrieval,
    retrieval_ci95: 0.5,
    answer_mean: answer,
    n_queries: 8,
    error_rate,
  });

  it("breaks a dead-even tie on answer score, then on provider id", () => {
    const [top] = bestPerType([cell("zzz", 5, 5), cell("aaa", 5, 5), cell("mid", 5, 6)]);
    expect(top.provider).toBe("mid");
    expect(top.runner_up).toBe("aaa");
    expect(top.decided_by).toBe("inconclusive");
  });

  it("does not let reliability override a quality gap that is real", () => {
    // 2.0 apart with a ±0.5 interval: separated. The flakier provider wins on
    // merit, and reliability never gets a vote — this is the guard against
    // turning the picker into a pure uptime ranking.
    const [top] = bestPerType([cell("flaky", 7, 7, 0.15), cell("steady", 5, 5, 0)]);
    expect(top).toMatchObject({ provider: "flaky", decided_by: "retrieval", margin: 2 });
  });

  it("refuses a real quality win to a provider that fails too often", () => {
    // Same 2.0 gap, but now the leader drops one call in three. Past the floor
    // the lead stops mattering: you cannot use source quality you never receive.
    const [top] = bestPerType([cell("flaky", 7, 7, 0.33), cell("steady", 5, 5, 0)]);
    expect(top).toMatchObject({
      provider: "steady",
      decided_by: "reliability",
      margin: -2,
      error_rate: 0,
    });
  });

  it("keeps the floor from firing on a rounding-sized reliability edge", () => {
    // Both are past the floor and near-identical on it, so the quality gap is
    // still the only thing separating them.
    const [top] = bestPerType([cell("flaky", 7, 7, 0.33), cell("alsoflaky", 5, 5, 0.31)]);
    expect(top).toMatchObject({ provider: "flaky", decided_by: "retrieval" });
  });
});
