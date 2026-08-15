import { describe, expect, it } from "vitest";
import {
  dedupeFetchRows,
  fetchKey,
  panelMeans,
  PooledFetchRow,
  PooledJudgementRow,
  resumableJudgementKeys,
  scoreQuery,
  summarizePooled,
  varianceShares,
} from "./pooled";
import { pairKey } from "./pool";

// The scoring rules here ARE the method: failures are misses, our-fault rows
// are excluded and published, kappa is reported beside raw agreement because
// each lies alone. These tests pin the rules to worked examples so a refactor
// can't quietly re-decide the methodology.

function fetchRow(over: Partial<PooledFetchRow>): PooledFetchRow {
  return {
    queryId: "q1",
    type: "how_to",
    query: "Q?",
    provider: "exa",
    num_sources: 2,
    num_extracted: 2,
    urls: ["https://a.com/1", "https://a.com/2"],
    sources: [],
    ...over,
  };
}

function judgement(over: Partial<PooledJudgementRow>): PooledJudgementRow {
  return { queryId: "q1", url: "https://a.com/1", judge: "j1", rung: 2, rationale: "", ...over };
}

describe("scoreQuery — the failure rules", () => {
  const verdicts = new Map([
    [pairKey("q1", "https://a.com/1"), 3],
    [pairKey("q1", "https://a.com/2"), 1],
  ]);
  const relevant = new Set([pairKey("q1", "https://a.com/1")]);

  it("scores a normal row: graded mean, binary precision, recall vs the pool", () => {
    const s = scoreQuery(fetchRow({}), verdicts, relevant, 2);
    expect(s).toEqual({ mean_rung: 2, precision: 0.5, recall: 0.5 });
  });

  it("a provider-fault failure is a miss: zero, not a dropped row", () => {
    const s = scoreQuery(
      fetchRow({ urls: [], error: "500 from provider", error_stage: "provider" }),
      verdicts,
      relevant,
      2,
    );
    expect(s).toEqual({ mean_rung: 0, precision: 0, recall: 0 });
  });

  it("returning nothing is the same miss as failing — no pages either way", () => {
    const s = scoreQuery(fetchRow({ urls: [] }), verdicts, relevant, 2);
    expect(s).toEqual({ mean_rung: 0, precision: 0, recall: 0 });
  });

  it("our network dying is excluded, never scored against the provider", () => {
    const s = scoreQuery(
      fetchRow({ urls: [], error: "fetch failed", error_stage: "provider" }),
      verdicts,
      relevant,
      2,
    );
    expect(s).toBeNull();
  });

  it("our billing dying is excluded too — a 402 measures the wallet", () => {
    const s = scoreQuery(
      fetchRow({ urls: [], error: "402 Insufficient credits", error_stage: "provider" }),
      verdicts,
      relevant,
      2,
    );
    expect(s).toBeNull();
  });

  it("recall is unmeasurable (null) when the pool holds no relevant page", () => {
    const s = scoreQuery(fetchRow({}), verdicts, new Set(), 0);
    expect(s?.recall).toBeNull();
  });
});

describe("panelMeans", () => {
  it("averages judges per pair and ignores null rungs instead of counting them as 0", () => {
    const means = panelMeans([
      judgement({ judge: "j1", rung: 3 }),
      judgement({ judge: "j2", rung: 1 }),
      judgement({ judge: "j3", rung: null }),
    ]);
    expect(means.get(pairKey("q1", "https://a.com/1"))).toBe(2);
  });
});

describe("agreement — via summarizePooled", () => {
  it("shows the kappa paradox: 90% raw agreement, kappa below zero", () => {
    // 90 pairs where both judges say 0; 5 where A=2,B=0; 5 where A=0,B=2.
    // Raw agreement 0.9 — but both judges say "0" almost always, so nearly all
    // of it is habit: kappa comes out negative. Both numbers describe the same
    // judges, which is exactly why the summary must carry both.
    const judgements: PooledJudgementRow[] = [];
    const fetches: PooledFetchRow[] = [];
    for (let i = 0; i < 100; i++) {
      const url = `https://a.com/${i}`;
      const a = i < 90 ? 0 : i < 95 ? 2 : 0;
      const b = i < 90 ? 0 : i < 95 ? 0 : 2;
      judgements.push(judgement({ url, judge: "j1", rung: a }));
      judgements.push(judgement({ url, judge: "j2", rung: b }));
    }
    const summary = summarizePooled(fetches, judgements, {
      judges: ["openai/j1", "openai/j2"],
      now: 0,
    });
    const agr = summary.agreement[0];
    expect(agr.raw_agreement).toBe(0.9);
    expect(agr.kappa).toBeLessThan(0);
    expect(summary.rung_distribution.find((d) => d.judge === "j1")?.counts[0]).toBe(95);
  });
});

describe("the sharpness slice", () => {
  it("splits agreement by whether the question had one right answer", () => {
    // Two judges who agree perfectly on the question with a checkable answer and
    // not at all on the open one. The headline number averages the two into 50%
    // and hides which half the disagreement came from — showing that is the
    // whole reason questions carry the tag.
    const fetches: PooledFetchRow[] = [
      fetchRow({ queryId: "q1", sharpness: "sharp", urls: ["https://a.com/1"] }),
      fetchRow({ queryId: "q2", sharpness: "open", urls: ["https://a.com/2"] }),
    ];
    const judgements: PooledJudgementRow[] = [
      judgement({ queryId: "q1", url: "https://a.com/1", judge: "j1", rung: 3 }),
      judgement({ queryId: "q1", url: "https://a.com/1", judge: "j2", rung: 3 }),
      judgement({ queryId: "q2", url: "https://a.com/2", judge: "j1", rung: 3 }),
      judgement({ queryId: "q2", url: "https://a.com/2", judge: "j2", rung: 0 }),
    ];
    const summary = summarizePooled(fetches, judgements, {
      judges: ["openai/j1", "openai/j2"],
      now: 0,
    });

    const split = Object.fromEntries(summary.agreement_by_sharpness.map((a) => [a.sharpness, a]));
    expect(split.sharp.raw_agreement).toBe(1);
    expect(split.open.raw_agreement).toBe(0);
    expect(summary.agreement[0].raw_agreement).toBe(0.5);
    expect(summary.by_sharpness.map((r) => r.sharpness).sort()).toEqual(["open", "sharp"]);
  });

  it("produces no slice at all for an untagged set, rather than an empty bucket", () => {
    // The built-in 48 carry no tag. A run over them should say nothing about
    // sharpness instead of reporting a bucket that means nothing.
    const summary = summarizePooled([fetchRow({})], [judgement({})], {
      judges: ["openai/j1"],
      now: 0,
    });
    expect(summary.by_sharpness).toEqual([]);
    expect(summary.agreement_by_sharpness).toEqual([]);
  });
});

describe("varianceShares", () => {
  it("attributes variance to providers when one is simply better everywhere", () => {
    const cells = [];
    for (const query of ["q1", "q2", "q3"]) {
      for (const judge of ["j1", "j2"]) {
        cells.push({ query, provider: "good", judge, value: 3 });
        cells.push({ query, provider: "bad", judge, value: 1 });
      }
    }
    const v = varianceShares(cells);
    expect(v.provider).toBeGreaterThan(0.9);
    expect(v.provider_by_query).toBeLessThan(0.05);
  });

  it("attributes variance to the interaction when providers have specialities", () => {
    // p1 wins q1, p2 wins q2 — averaged into a leaderboard they tie, and the
    // provider main effect is ~0 while the interaction carries everything.
    const cells = [];
    for (const judge of ["j1", "j2"]) {
      cells.push({ query: "q1", provider: "p1", judge, value: 3 });
      cells.push({ query: "q1", provider: "p2", judge, value: 1 });
      cells.push({ query: "q2", provider: "p1", judge, value: 1 });
      cells.push({ query: "q2", provider: "p2", judge, value: 3 });
    }
    const v = varianceShares(cells);
    expect(v.provider).toBeLessThan(0.05);
    expect(v.provider_by_query).toBeGreaterThan(0.9);
  });

  it("returns zeros rather than NaN on constant scores", () => {
    const v = varianceShares([
      { query: "q1", provider: "p1", judge: "j1", value: 2 },
      { query: "q2", provider: "p1", judge: "j1", value: 2 },
    ]);
    expect(v.provider).toBe(0);
    expect(v.residual).toBe(0);
  });
});

describe("append-only log hygiene", () => {
  it("last write wins per fetch, and transport failures drop so resume retries them", () => {
    const rows = [
      fetchRow({ error: "fetch failed" }),
      fetchRow({}), // the retry that landed
      fetchRow({ queryId: "q2", error: "fetch failed" }), // never retried → dropped
    ];
    const deduped = dedupeFetchRows(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].queryId).toBe("q1");
    expect(deduped[0].error).toBeUndefined();
    expect(fetchKey("q1", "exa")).toBe("q1|exa");
  });

  it("resume skips landed judgements but re-attempts errored ones", () => {
    const keys = resumableJudgementKeys([
      judgement({}),
      judgement({ url: "https://a.com/2", rung: null, error: "Request timed out." }),
    ]);
    expect(keys.size).toBe(1);
  });
});

describe("summarizePooled — misses and exclusions land in the stats", () => {
  it("keeps a failing provider visible in mean and miss count", () => {
    const fetches = [
      fetchRow({ provider: "good" }),
      fetchRow({ provider: "flaky", urls: [], sources: [], error: "500", error_stage: "provider" }),
      fetchRow({ provider: "broke", urls: [], sources: [], error: "402 payment required", error_stage: "provider" }),
    ];
    const judgements = [
      judgement({ judge: "j1", rung: 3 }),
      judgement({ judge: "j1", url: "https://a.com/2", rung: 1 }),
    ];
    const summary = summarizePooled(fetches, judgements, { judges: ["openai/j1"], now: 0 });
    const good = summary.by_provider.find((p) => p.provider === "good")!;
    const flaky = summary.by_provider.find((p) => p.provider === "flaky")!;
    const broke = summary.by_provider.find((p) => p.provider === "broke")!;
    expect(good.mean_rung).toBe(2);
    expect(flaky.mean_rung).toBe(0);
    expect(flaky.n_misses).toBe(1);
    // The account failure is excluded from scoring but published as a count.
    expect(broke.n_queries).toBe(0);
    expect(broke.n_excluded).toBe(1);
  });
});
