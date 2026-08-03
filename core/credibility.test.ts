import { describe, expect, it } from "vitest";
import {
  mean,
  stddev,
  ci95,
  pearson,
  judgeLabel,
  summarize,
  armKey,
  runCredibility,
  type CredibilityRow,
} from "./credibility";

describe("stats helpers", () => {
  it("mean / stddev / ci95 behave on known inputs", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBe(0);
    // sample std of [2,4,6] = 2
    expect(stddev([2, 4, 6])).toBeCloseTo(2, 6);
    expect(stddev([5])).toBe(0); // n<2 → 0
    // constant sample → zero-width CI
    expect(ci95([7, 7, 7, 7, 7])).toBe(0);
    // n=5, mean 4, std 2 → t(.975,4)=2.776, ci = 2.776*2/sqrt(5)
    expect(ci95([2, 4, 6, 2, 6])).toBeGreaterThan(0);
  });

  it("pearson is 1 for a perfect line, 0 for a constant", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 6);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it("judgeLabel takes the last path segment", () => {
    expect(judgeLabel("fireworks/accounts/fireworks/models/glm-5p2")).toBe("glm-5p2");
    expect(judgeLabel("gpt-4o-mini")).toBe("gpt-4o-mini");
  });
});

// Build a synthetic row where both judges agree/disagree in controlled ways so
// the aggregation math is checkable by hand.
function row(
  queryId: string,
  provider: CredibilityRow["provider"],
  seed: number,
  scores: { a_ret: number; b_ret: number; a_ans: number; b_ans: number },
): CredibilityRow {
  return {
    queryId,
    type: "product_lookup",
    query: `q-${queryId}`,
    provider,
    seed,
    num_sources: 3,
    num_sources_extracted: 3,
    median_source_age_days: 30,
    domains: ["a.com"],
    latency_ms: 100,
    judgements: [
      { judge: "jA", retrieval_score: scores.a_ret, retrieval_rationale: "", answer_score: scores.a_ans, answer_rationale: "" },
      { judge: "jB", retrieval_score: scores.b_ret, retrieval_rationale: "", answer_score: scores.b_ans, answer_rationale: "" },
    ],
  };
}

describe("summarize", () => {
  // Bright Data: retrieval deterministic across seeds (seed noise 0), judges
  // differ by exactly 2 every arm (judge gap = 2). Firecrawl: one errored arm.
  const rows: CredibilityRow[] = [
    row("p1", "bright_data", 0, { a_ret: 6, b_ret: 8, a_ans: 7, b_ans: 7 }),
    row("p1", "bright_data", 1, { a_ret: 6, b_ret: 8, a_ans: 7, b_ans: 7 }),
    row("p2", "bright_data", 0, { a_ret: 4, b_ret: 6, a_ans: 5, b_ans: 5 }),
    row("p2", "bright_data", 1, { a_ret: 4, b_ret: 6, a_ans: 5, b_ans: 5 }),
    row("p1", "firecrawl", 0, { a_ret: 9, b_ret: 7, a_ans: 8, b_ans: 8 }),
    { ...row("p2", "firecrawl", 0, { a_ret: 0, b_ret: 0, a_ans: 0, b_ans: 0 }), judgements: [], error: "boom" },
  ];
  const summary = summarize(rows, {
    seeds: 2,
    answer_model: "answer-model",
    judges: ["prov/jA", "prov/jB"],
    now: Date.UTC(2026, 6, 23),
  });

  it("computes per-provider means over queries (folding seed+judge noise)", () => {
    const bd = summary.by_provider.find((p) => p.provider === "bright_data")!;
    // p1 mean = mean(6,8,6,8)=7 ; p2 mean = mean(4,6,4,6)=5 ; provider mean = 6
    expect(bd.retrieval_mean).toBe(6);
    expect(bd.n_queries).toBe(2);
  });

  it("skips errored arms in aggregation", () => {
    const fc = summary.by_provider.find((p) => p.provider === "firecrawl")!;
    // only p1 survives → n_queries 1, retrieval mean = mean(9,7) = 8
    expect(fc.n_queries).toBe(1);
    expect(fc.retrieval_mean).toBe(8);
    expect(summary.n_errors).toBe(1);
    expect(summary.n_rows).toBe(6);
  });

  it("measures inter-judge agreement", () => {
    const ret = summary.agreement.find((a) => a.metric === "retrieval")!;
    // jA vs jB differ by 2 on every non-errored arm → mean_abs_diff 2, within±1 0%
    expect(ret.mean_abs_diff).toBe(2);
    expect(ret.within_1_rate).toBe(0);
    const ans = summary.agreement.find((a) => a.metric === "answer")!;
    // answers identical → perfect agreement
    expect(ans.mean_abs_diff).toBe(0);
    expect(ans.within_1_rate).toBe(1);
  });

  it("decomposes variance: seeds ~0, judges = the real spread", () => {
    // retrieval identical across seeds → seed_std_mean 0
    expect(summary.variance.seed_std_mean).toBe(0);
    // |jA-jB| = 2 on every graded arm → judge_gap_mean 2
    expect(summary.variance.judge_gap_mean).toBe(2);
  });
});

describe("resume", () => {
  it("skips arms already on disk — a fully-covered run does no work", async () => {
    const queries = [{ id: "q1", type: "breaking_news" as const, query: "x" }];
    const done = new Set<string>();
    for (const p of ["bright_data", "firecrawl"] as const)
      for (let s = 0; s < 2; s++) done.add(armKey("q1", p, s));

    // Providers named explicitly: the default set is resolved from whichever
    // keys are present, so leaving it implicit made this assert against a
    // different arm list on a machine that happened to hold a key.
    // If any arm survived the filter this would hit the network and fail/hang.
    const rows = await runCredibility(queries, {
      judges: ["j"],
      seeds: 2,
      done,
      providers: ["bright_data", "firecrawl"],
    });
    expect(rows).toEqual([]);
  });
});

describe("fail-fast on a dead provider", () => {
  const q = (i: number) => ({ id: `q${i}`, type: "breaking_news" as const, query: "x" });

  it("aborts once a provider has failed N arms with zero successes", async () => {
    // No keys are set in the test env, so every fetch throws immediately —
    // which is exactly the systematically-broken-provider case.
    const rows: CredibilityRow[] = [];
    await expect(
      runCredibility([q(1), q(2), q(3), q(4), q(5)], {
        judges: ["j"],
        seeds: 2,
        concurrency: 1,
        failFast: 3,
        // Pinned so an unkeyed `plain` arm can never be the default here — it
        // needs no credentials, so it would reach the live network.
        providers: ["bright_data", "firecrawl"],
        onRow: (r) => rows.push(r),
      }),
    ).rejects.toThrow(/aborting before this burns/);
    // Rows seen before the abort were still handed to the caller to persist.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.error)).toBe(true);
  });

  it("does not abort when failFast is 0", async () => {
    const rows = await runCredibility([q(1)], {
      judges: ["j"],
      seeds: 1,
      concurrency: 1,
      failFast: 0,
      providers: ["bright_data", "firecrawl"],
    });
    expect(rows).toHaveLength(2); // both providers, both errored
    expect(rows.every((r) => r.error)).toBe(true);
  });
});

describe("summary reports what actually ran", () => {
  it("derives providers and query count from the rows, not from assumptions", () => {
    // A single-provider run must not claim it compared two.
    const rows = [
      row("p1", "bright_data", 0, { a_ret: 6, b_ret: 8, a_ans: 7, b_ans: 7 }),
      row("p2", "bright_data", 0, { a_ret: 4, b_ret: 6, a_ans: 5, b_ans: 5 }),
    ];
    const s = summarize(rows, {
      seeds: 1,
      answer_model: "m",
      judges: ["prov/jA", "prov/jB"],
      now: Date.UTC(2026, 6, 24),
    });
    expect(s.providers).toEqual(["bright_data"]);
    expect(s.n_queries).toBe(2);
    expect(s.by_provider).toHaveLength(1);
  });
});
