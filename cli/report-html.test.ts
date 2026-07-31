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
      answer: "Registration moved to a beneficiary-centric selection.",
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
      retrieval_rationale: "Sources are <recent> and on-topic.", // escaping in a rationale too
      score: 7,
      rationale: "Grounded in the cited USCIS page.",
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
    {
      // Ran fine but produced nothing to show — pins the muted fallbacks.
      id: "C",
      provider: "tavily",
      config: { freshness: "all", num_sources: 8, extraction: "clean" },
      model: "gpt-4o-mini",
      answer: "",
      sources: [],
      latency_ms: 900,
      retrieval_score: 3,
      retrieval_rationale: "",
      score: 2,
      rationale: "",
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
    retrieval_rationale: "Top hits predate the announcement.",
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
    // Winner badge + failed arm's error surfaced.
    expect(html).toContain(">best<");
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
    expect(html).toContain("judge <span class=\"mono\">gpt-4o-mini</span>");
    // Summary tiles describe the whole log, not just the latest batch.
    expect(html).toContain("arms");
    expect(html).toContain("arm failure rate");
  });

  it("shows each arm's answer and both judge rationales, paired to their scores", () => {
    const html = buildReport(
      [runRec, batchRec(4, "bright_data"), batchRec(6, "firecrawl")],
      "2026-07-23T01:00:00.000Z",
    );

    // The answer text itself is on the page, not just its score.
    expect(html).toContain("Registration moved to a beneficiary-centric selection.");
    // Rationale text is escaped like everything else.
    expect(html).toContain("Sources are &lt;recent&gt; and on-topic.");
    expect(html).not.toContain("<recent>");

    // The pairing is the load-bearing claim, so assert the ORDERED triple of
    // (metric, score, rationale) rather than the presence of each part. An
    // earlier version of this test checked only that both headings and both
    // rationales appeared somewhere on the page, which still passed when the two
    // rationales were swapped — the one failure it existed to catch. A swap
    // would publish the answer judge's words under the retrieval score, which
    // reads as plausible and is a lie about which judge said what.
    const verdicts = [
      ...html.matchAll(
        /<div class="vd-h">(\w+) score <span class="chip[^"]*">(\d+)<\/span><\/div>\s*<p class="vd-r">([\s\S]*?)<\/p>/g,
      ),
    ].map((m) => ({ metric: m[1], score: Number(m[2]), rationale: m[3] }));

    const retrieval = verdicts.find((v) => v.metric === "Retrieval" && v.score === 8);
    const answer = verdicts.find((v) => v.metric === "Answer" && v.score === 7);
    expect(retrieval?.rationale).toBe("Sources are &lt;recent&gt; and on-topic.");
    expect(answer?.rationale).toBe("Grounded in the cited USCIS page.");

    // Arm C ran but recorded nothing: explicit placeholders, not blank boxes.
    expect(html).toContain("(no answer recorded)");
    expect(html).toContain("(no rationale recorded)");
    // A failed arm degrades to its error and never invents a score for itself.
    expect(html).toContain("FIRECRAWL_API_KEY missing");
    const firecrawlArm = html.slice(html.indexOf("FIRECRAWL_API_KEY missing") - 700);
    expect(firecrawlArm.slice(0, 700)).not.toContain("Answer score");
    // Batch rationales are reachable from the heatmap, per (query, provider) row.
    expect(html).toContain("bn-01");
    expect(html).toContain("Top hits predate the announcement.");
    // Still zero JS, and no scheme that executes — the report is a static file
    // the user opens locally, and source URLs are scraped from SERP results.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("refuses to link a source URL that isn't http(s)", () => {
    const hostile: RunRecord = {
      ...runRec,
      arms: [
        {
          ...runRec.arms[0],
          sources: [
            {
              title: "click me",
              url: "javascript:alert(1)",
              published: null,
              domain: "evil.test",
              content: "x",
            },
          ],
        },
      ],
    };
    const html = buildReport([hostile], "2026-07-23T01:00:00.000Z");
    // The title still renders, so nothing is silently dropped from the report.
    expect(html).toContain("click me");
    // But it is not a link, and the scheme never reaches an href.
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<span class="src-t">click me</span>');
  });

  it("survives a record with fields missing", () => {
    // readRecords is a JSON.parse cast with no schema check, and core/types.ts
    // says older lines stay valid records. One malformed line must not take the
    // whole report down.
    const partial = {
      mode: "run",
      id: "run_2",
      ts: "2026-07-23T00:00:00.000Z",
      query: "q",
      variable: "provider",
      winner: null,
      judge_model: "gpt-4o-mini",
      arms: [{ id: "A", provider: "exa" }],
    } as unknown as RunRecord;
    expect(() => buildReport([partial], "2026-07-23T01:00:00.000Z")).not.toThrow();
    const html = buildReport([partial], "2026-07-23T01:00:00.000Z");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("shows an empty state when there are no records", () => {
    expect(buildReport([], "2026-07-23T01:00:00.000Z")).toContain("Nothing recorded yet");
  });
});
