import { describe, expect, it } from "vitest";
import { deriveHeatmap, runsPerCell, selectQueries, type BatchRow } from "./batch";
import type { QueryType } from "./eval-dataset";
import type { Provider } from "./types";

// `sourcery report` re-derives the heatmap from persisted rows while `sourcery
// batch` derives it in-process — same function, so these tests pin the shape
// both paths depend on.
function row(
  type: QueryType,
  provider: Provider,
  retrieval_score: number,
  error?: string,
): BatchRow {
  return {
    queryId: `${type}-${provider}-${retrieval_score}`,
    type,
    query: "q",
    provider,
    retrieval_score,
    answer_score: 5,
    retrieval_rationale: "",
    median_source_age_days: null,
    num_sources: 3,
    num_sources_extracted: 3,
    latency_ms: 100,
    ...(error ? { error } : {}),
  };
}

describe("deriveHeatmap", () => {
  it("averages retrieval score per (type, provider) and rounds to 2dp", () => {
    const heat = deriveHeatmap([
      row("how_to", "bright_data", 8),
      row("how_to", "bright_data", 7),
      row("how_to", "firecrawl", 6),
      row("how_to", "firecrawl", 5),
    ]);
    expect(heat).toEqual([
      {
        type: "how_to",
        label: "how-to / explainer",
        scores: { bright_data: 7.5, firecrawl: 5.5 },
        runs: 2,
      },
    ]);
  });

  it("plots any number of providers, not just two", () => {
    // The reason `scores` is a map. While HeatRow named bright_data and firecrawl
    // as fields, the other three registered adapters could never be plotted —
    // the type was silently deciding which providers the tool had opinions about.
    const [cell] = deriveHeatmap([
      row("how_to", "firecrawl", 6),
      row("how_to", "tavily", 3),
      row("how_to", "exa", 7),
    ]);
    expect(cell.scores).toEqual({ firecrawl: 6, tavily: 3, exa: 7 });
  });

  it("skips errored arms so one failure doesn't tank a cell", () => {
    const [cell] = deriveHeatmap([
      row("breaking_news", "bright_data", 9),
      row("breaking_news", "bright_data", 0, "429 rate limited"),
      row("breaking_news", "firecrawl", 4),
    ]);
    expect(cell.scores.bright_data).toBe(9); // not (9+0)/2
    expect(cell.runs).toBe(1); // max of the two providers' surviving counts
  });

  it("scores 0 for a requested provider with no surviving arms", () => {
    // runBatch passes its provider list explicitly, so a provider whose every
    // arm failed still gets a column of zeros rather than vanishing from the
    // grid — "it failed" and "it wasn't run" must not look identical.
    const [cell] = deriveHeatmap([row("local_geo", "firecrawl", 6)], [
      "bright_data",
      "firecrawl",
    ]);
    expect(cell.scores.bright_data).toBe(0);
    expect(cell.scores.firecrawl).toBe(6);
  });

  it("omits a provider entirely when the column list is derived from the rows", () => {
    // `report` reads history it didn't run, so it derives columns from the data.
    const [cell] = deriveHeatmap([row("local_geo", "firecrawl", 6)]);
    expect(Object.keys(cell.scores)).toEqual(["firecrawl"]);
  });

  it("emits only the types present, in dataset order — not input order", () => {
    const heat = deriveHeatmap([
      row("numeric_live", "firecrawl", 5),
      row("breaking_news", "firecrawl", 5),
      row("how_to", "firecrawl", 5),
    ]);
    expect(heat.map((h) => h.type)).toEqual(["breaking_news", "how_to", "numeric_live"]);
  });

  it("returns [] for no rows, and runsPerCell is 0", () => {
    expect(deriveHeatmap([])).toEqual([]);
    expect(runsPerCell([])).toBe(0);
  });

  it("runsPerCell rounds the mean across cells", () => {
    const heat = deriveHeatmap([
      row("how_to", "bright_data", 8),
      row("how_to", "firecrawl", 8),
      row("local_geo", "bright_data", 8),
      row("local_geo", "bright_data", 7),
      row("local_geo", "firecrawl", 6),
    ]);
    expect(heat.map((h) => h.runs)).toEqual([1, 2]);
    expect(runsPerCell(heat)).toBe(2); // mean 1.5 → 2
  });
});

describe("selectQueries", () => {
  it("caps per type and returns the full set when perType is 0", () => {
    const capped = selectQueries(2);
    const byType = new Map<QueryType, number>();
    for (const q of capped) byType.set(q.type, (byType.get(q.type) ?? 0) + 1);
    expect([...byType.values()].every((n) => n <= 2)).toBe(true);
    expect(selectQueries(0).length).toBeGreaterThan(capped.length);
  });
});
