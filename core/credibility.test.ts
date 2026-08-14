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
  createNetworkBreaker,
  dedupeRows,
  isTransportFailure,
  isAccountFailure,
  isProviderFailure,
  percentile,
  resumableKeys,
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

  it("percentile returns null on an empty sample rather than 0", () => {
    // 0 would render as an infinitely fast provider. The absence of a
    // measurement has to be distinguishable from a measurement of zero.
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([], 0.95)).toBeNull();
  });

  it("percentile picks by nearest rank", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.95)).toBe(100);
    expect(percentile([42], 0.5)).toBe(42);
    // unsorted input must not change the answer
    expect(percentile([90, 10, 50], 0.5)).toBe(50);
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

describe("resume after a dropped connection", () => {
  // The scenario this exists for: the wifi goes out 200 results into a 480-result
  // run. Those results land on disk as failures. Without this, --resume skips
  // them as "done" and publishes an outage as a provider's failure rate — the
  // one number the whole run exists to measure.
  const row = (
    queryId: string,
    provider: string,
    seed: number,
    error?: string,
  ): CredibilityRow => ({
    queryId,
    type: "how_to",
    query: "q",
    provider: provider as CredibilityRow["provider"],
    seed,
    num_sources: error ? 0 : 8,
    num_sources_extracted: error ? 0 : 8,
    median_source_age_days: null,
    domains: [],
    latency_ms: 1,
    judgements: [],
    ...(error ? { error } : {}),
  });

  it("treats a lost network as a transport failure", () => {
    expect(isTransportFailure("fetch failed")).toBe(true);
    expect(isTransportFailure("getaddrinfo ENOTFOUND api.tavily.com")).toBe(true);
    expect(isTransportFailure("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
  });

  it("treats a provider's own failure as data, not an outage", () => {
    // These are the measurement. Retrying them until they pass would invent a
    // better reliability number than the provider earned.
    expect(isTransportFailure("Bright Data returned non-JSON: This query recently failed")).toBe(false);
    expect(isTransportFailure("429 Rate limit reached")).toBe(false);
    expect(isTransportFailure("402 Payment Required")).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
  });

  it("resume skips completed and provider-failed results, but retries network ones", () => {
    const keys = resumableKeys([
      row("q1", "tavily", 0),
      row("q2", "tavily", 0, "429 Rate limit reached"),
      row("q3", "tavily", 0, "fetch failed"),
    ]);
    expect(keys.has(armKey("q1", "tavily", 0))).toBe(true);
    expect(keys.has(armKey("q2", "tavily", 0))).toBe(true);
    expect(keys.has(armKey("q3", "tavily", 0))).toBe(false);
  });

  it("a retried result supersedes the attempt it replaces", () => {
    // The log is append-only, so both rows are on disk. Counting the old failure
    // would keep it in the error rate forever.
    const deduped = dedupeRows([
      row("q1", "tavily", 0, "fetch failed"),
      row("q1", "tavily", 0),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].error).toBeUndefined();
  });

  it("drops a network failure that was never retried rather than blaming the provider", () => {
    expect(dedupeRows([row("q1", "tavily", 0, "ENOTFOUND")])).toHaveLength(0);
  });

  it("keeps every distinct result", () => {
    const rows = [row("q1", "tavily", 0), row("q1", "tavily", 1), row("q1", "exa", 0)];
    expect(dedupeRows(rows)).toHaveLength(3);
  });
});

describe("whose fault was it", () => {
  // The published run said Firecrawl failed 2 of 240. Both were 402s from an
  // exhausted plan. An eval that can't tell "the provider broke" from "you ran
  // out of money" is measuring your wallet and printing it as reliability — in a
  // table next to a competitor.
  it("blames the account, not the provider, for a 402", () => {
    const e = 'Firecrawl 402: {"success":false,"error":"Insufficient credits"}';
    expect(isAccountFailure(e)).toBe(true);
    expect(isProviderFailure(e)).toBe(false);
  });

  it("blames the provider for its own bad response", () => {
    const e = "Bright Data returned non-JSON: Error while processing request";
    expect(isProviderFailure(e)).toBe(true);
    expect(isAccountFailure(e)).toBe(false);
  });

  it("blames nobody for a dead network", () => {
    expect(isProviderFailure("fetch failed")).toBe(false);
    expect(isAccountFailure("fetch failed")).toBe(false);
  });

  it("treats a rate limit as the provider's, since it is a real refusal to serve", () => {
    // Distinct from a 402: you had budget, they declined. That IS reliability.
    expect(isProviderFailure("429 Rate limit reached for model")).toBe(true);
  });

  it("counts a clean run as no failure at all", () => {
    expect(isProviderFailure(undefined)).toBe(false);
    expect(isAccountFailure(undefined)).toBe(false);
  });
});

describe("provider latency is the fetch alone", () => {
  // latency_ms spans fetch + answer + the whole judge panel. Reporting it as a
  // provider's latency publishes my own LLM's slowness under their name — the
  // same class of mistake as charging them for my failed answer call.
  function timed(queryId: string, provider: CredibilityRow["provider"], fetchMs?: number): CredibilityRow {
    const r = row(queryId, provider, 0, { a_ret: 5, b_ret: 5, a_ans: 5, b_ans: 5 });
    // latency_ms is deliberately enormous next to fetch_ms: if anything ever
    // reads the wrong field, these numbers make it obvious which one it took.
    return { ...r, latency_ms: 90_000, ...(fetchMs === undefined ? {} : { fetch_ms: fetchMs }) };
  }

  it("reports percentiles over fetch_ms, never latency_ms", () => {
    const rows = [
      timed("q1", "exa", 1000),
      timed("q2", "exa", 2000),
      timed("q3", "exa", 3000),
    ];
    const stat = summarize(rows, { seeds: 1, answer_model: "m", judges: ["prov/jA", "prov/jB"], now: 0 })
      .by_provider.find((p) => p.provider === "exa")!;
    expect(stat.fetch_ms_p50).toBe(2000);
    expect(stat.n_fetch_timed).toBe(3);
    // the 90s full-arm number must not have leaked in anywhere
    expect(stat.fetch_ms_p95).toBeLessThan(90_000);
  });

  it("reports null, not zero, when no arm carried a fetch_ms", () => {
    // Every row predates the field. A p50 of 0 here would rank this provider
    // fastest in the table on the strength of never having been measured.
    const rows = [timed("q1", "exa"), timed("q2", "exa")];
    const stat = summarize(rows, { seeds: 1, answer_model: "m", judges: ["prov/jA", "prov/jB"], now: 0 })
      .by_provider.find((p) => p.provider === "exa")!;
    expect(stat.fetch_ms_p50).toBeNull();
    expect(stat.fetch_ms_p95).toBeNull();
    expect(stat.n_fetch_timed).toBe(0);
  });

  it("counts only the timed arms, so partial coverage is visible", () => {
    // A resumed run mixes old untimed rows with new ones. The p50 is honest for
    // what it covers; n_fetch_timed vs n_arms is what stops it being read as all.
    const rows = [
      timed("q1", "exa", 1000),
      timed("q2", "exa"),
      timed("q3", "exa"),
      timed("q4", "exa"),
    ];
    const stat = summarize(rows, { seeds: 1, answer_model: "m", judges: ["prov/jA", "prov/jB"], now: 0 })
      .by_provider.find((p) => p.provider === "exa")!;
    expect(stat.fetch_ms_p50).toBe(1000);
    expect(stat.n_fetch_timed).toBe(1);
    expect(stat.n_arms).toBe(4);
  });
});

describe("a network that dies mid-run", () => {
  it("classifies the SDK's connection error as transport", () => {
    // The exact string the OpenAI-compatible client raises when it can't reach
    // the host. It was being counted as a provider failure.
    expect(isTransportFailure("Connection error.")).toBe(true);
    expect(isProviderFailure("Connection error.")).toBe(false);
  });

  it("trips after N consecutive transport failures", () => {
    // What actually happened: the connection died 70 results into 480, and
    // failFast — which only ever looked at a provider's FIRST results — let the
    // run burn the remaining 412 in minutes before finishing.
    const b = createNetworkBreaker(4);
    expect(b.observe("fetch failed")).toBe(true);
    b.observe("fetch failed");
    b.observe("Connection error.");
    expect(() => b.observe("fetch failed")).toThrow(/lost its connection/);
  });

  it("resets on any success, so a slow provider never trips it", () => {
    const b = createNetworkBreaker(3);
    b.observe("fetch failed");
    b.observe("fetch failed");
    b.observe(undefined); // one result got through — the network is fine
    expect(() => {
      b.observe("fetch failed");
      b.observe("fetch failed");
    }).not.toThrow();
  });

  it("resets on a provider's own failure, which proves the network is up", () => {
    const b = createNetworkBreaker(3);
    b.observe("fetch failed");
    b.observe("fetch failed");
    expect(b.observe("Bright Data returned non-JSON")).toBe(false);
    expect(() => b.observe("fetch failed")).not.toThrow();
  });
});
