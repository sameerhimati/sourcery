import { describe, expect, it } from "vitest";
import type { BatchRowRecord, RunRecord } from "./persist";
import { detectColor, renderReportTui } from "./report-tui";

const ESC = String.fromCharCode(27);
const plain = { color: false, width: 100 };

const runRec: RunRecord = {
  mode: "run",
  id: "run_1",
  ts: "2026-07-23T00:00:00.000Z",
  query: "What changed in the H-1B lottery?",
  variable: "provider",
  winner: "A",
  judge_model: "gpt-4o-mini",
  arms: [
    {
      id: "A",
      provider: "bright_data",
      config: { freshness: "all", num_sources: 8, extraction: "clean" },
      model: "gpt-4o-mini",
      answer: "Registration moved to a beneficiary-centric selection.",
      sources: [
        {
          title: "USCIS update",
          url: "https://uscis.gov/h1b",
          published: "2026-03-01",
          domain: "uscis.gov",
          content: "…",
        },
      ],
      latency_ms: 1200,
      retrieval_score: 8,
      retrieval_rationale: "on-topic",
      score: 7,
      rationale: "grounded",
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

const batchRec = (provider: "bright_data" | "firecrawl", retrieval: number): BatchRowRecord => ({
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
    retrieval_rationale: "…",
    median_source_age_days: 30,
    num_sources: 8,
    num_sources_extracted: 8,
    latency_ms: 100,
  },
});

describe("detectColor", () => {
  it("respects NO_COLOR over everything else", () => {
    expect(detectColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });
  it("honours FORCE_COLOR when not a TTY", () => {
    expect(detectColor({ FORCE_COLOR: "1" }, false)).toBe(true);
  });
  it("is off when piped, on at a TTY", () => {
    expect(detectColor({}, false)).toBe(false);
    expect(detectColor({}, true)).toBe(true);
    expect(detectColor({ TERM: "dumb" }, true)).toBe(false);
  });
});

describe("renderReportTui", () => {
  const records = [runRec, batchRec("bright_data", 4), batchRec("firecrawl", 6)];

  it("emits no escape codes when colour is off", () => {
    expect(renderReportTui(records, plain)).not.toContain(ESC);
  });

  it("emits escape codes when colour is on", () => {
    expect(renderReportTui(records, { color: true, width: 100 })).toContain(ESC);
  });

  it("reports the summary, both metrics and the providers", () => {
    const out = renderReportTui(records, plain);
    expect(out).toContain("sourcery");
    expect(out).toContain("arms");
    expect(out).toContain("RETRIEVAL VS ANSWER");
    expect(out).toContain("retrieval");
    expect(out).toContain("answer");
    expect(out).toContain("Bright Data");
    expect(out).toContain("Firecrawl");
    // A failed arm says so instead of showing a fabricated zero.
    expect(out).toContain("failed");
  });

  it("orders heatmap columns the same way as the bar rows", () => {
    const out = renderReportTui(records, plain);
    const header = out.split("\n").find((l) => l.includes("Bright Data") && l.includes("Firecrawl"));
    expect(header).toBeDefined();
    // Both views use the registry order, so a reader isn't re-learning the
    // column layout halfway down the page.
    expect(header!.indexOf("Bright Data")).toBeLessThan(header!.indexOf("Firecrawl"));
  });

  it("pads to a stable width regardless of escape codes", () => {
    // Colour codes have zero display width; if padding counted them the coloured
    // render would visibly wander relative to the plain one.
    const widths = (s: string) =>
      s
        .split("\n")
        .filter((l) => l.includes("retrieval "))
        .map((l) => l.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").length);
    expect(widths(renderReportTui(records, { color: true, width: 100 }))).toEqual(
      widths(renderReportTui(records, plain)),
    );
  });

  it("degrades on an empty log and on a record with fields missing", () => {
    expect(renderReportTui([], plain)).toContain("Nothing recorded yet");
    const partial = {
      mode: "run",
      id: "r2",
      ts: "2026-07-23T00:00:00.000Z",
      query: "q",
      variable: "provider",
      winner: null,
      judge_model: "m",
      arms: [{ id: "A", provider: "exa" }],
    } as unknown as RunRecord;
    expect(() => renderReportTui([partial], plain)).not.toThrow();
    const out = renderReportTui([partial], plain);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });
});
