import { describe, expect, it } from "vitest";
import { deriveHeatmap, runsPerCell, selectQueries, type BatchRow } from "./batch";
import type { QueryType } from "./eval-dataset";
import type { Provider } from "./types";

// The dashboard re-derives the heatmap from persisted rows while `sourcery
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
      { type: "how_to", label: "how-to / explainer", bright_data: 7.5, firecrawl: 5.5, runs: 2 },
    ]);
  });

  it("skips errored arms so one failure doesn't tank a cell", () => {
    const [cell] = deriveHeatmap([
      row("breaking_news", "bright_data", 9),
      row("breaking_news", "bright_data", 0, "429 rate limited"),
      row("breaking_news", "firecrawl", 4),
    ]);
    expect(cell.bright_data).toBe(9); // not (9+0)/2
    expect(cell.runs).toBe(1); // max of the two providers' surviving counts
  });

  it("scores a cell 0 when a provider has no surviving arms for that type", () => {
    const [cell] = deriveHeatmap([row("local_geo", "firecrawl", 6)]);
    expect(cell.bright_data).toBe(0);
    expect(cell.firecrawl).toBe(6);
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
