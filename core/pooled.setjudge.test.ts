import { describe, expect, it, vi } from "vitest";

// Mocked so the phase's own rules — which rows get judged, what a thrown judge
// does, how resume behaves — are tested without an API call in sight.
const judged: { query: string; model: string }[] = [];
vi.mock("./setJudge", () => ({
  setJudge: vi.fn(async (query: string, _sources: unknown[], model: string) => {
    judged.push({ query, model });
    if (model === "broken") throw new Error("judge timed out");
    if (model === "garbling") return { score: null, rationale: "judge returned unparseable output" };
    return { score: 8, rationale: "good set" };
  }),
}));

const {
  dedupeSetVerdictRows,
  resumableSetVerdictKeys,
  runSetJudging,
  setVerdictKey,
  summarizePooled,
} = await import("./pooled");
type PooledFetchRow = import("./pooled").PooledFetchRow;
type PooledSetVerdictRow = import("./pooled").PooledSetVerdictRow;

function fetchRow(over: Partial<PooledFetchRow> = {}): PooledFetchRow {
  return {
    queryId: "q1",
    type: "how_to",
    query: "Q?",
    provider: "exa",
    num_sources: 1,
    num_extracted: 1,
    urls: ["https://a.com/1"],
    sources: [
      { title: "A", url: "https://a.com/1", domain: "a.com", snippet: "", content: "body" },
    ] as PooledFetchRow["sources"],
    ...over,
  };
}

function verdict(over: Partial<PooledSetVerdictRow> = {}): PooledSetVerdictRow {
  return { queryId: "q1", provider: "exa", judge: "j1", score: 8, rationale: "", ...over };
}

describe("runSetJudging — which rows are worth a judge call", () => {
  it("judges one call per returned set per judge", async () => {
    const rows = await runSetJudging([fetchRow(), fetchRow({ queryId: "q2" })], ["j1", "j2"]);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.score === 8)).toBe(true);
  });

  it("never judges a failed fetch — there is no set to grade, and phase 3 already knows what a failure means", async () => {
    const rows = await runSetJudging(
      [
        fetchRow({ urls: [], sources: [], error: "500", error_stage: "provider" }),
        fetchRow({ queryId: "q2", urls: [], sources: [], error: "our judge died", error_stage: "judge" }),
      ],
      ["j1"],
    );
    expect(rows).toHaveLength(0);
  });

  it("a judge that throws records an error row, and the row still names no provider fault", async () => {
    const rows = await runSetJudging([fetchRow()], ["broken"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toMatch(/timed out/);
    expect(rows[0].score).toBeNull();
  });

  it("a judge that garbles its answer scores null, not zero", async () => {
    const rows = await runSetJudging([fetchRow()], ["garbling"]);
    expect(rows[0].score).toBeNull();
    expect(rows[0].error).toBeUndefined(); // the call worked; the answer didn't
  });

  it("skips work already on disk", async () => {
    const done = new Set([setVerdictKey("q1", "exa", "j1")]);
    const rows = await runSetJudging([fetchRow(), fetchRow({ queryId: "q2" })], ["j1"], { done });
    expect(rows.map((r) => r.queryId)).toEqual(["q2"]);
  });
});

describe("set-verdict log hygiene", () => {
  it("resume keeps landed verdicts and retries errored ones", () => {
    const keys = resumableSetVerdictKeys([
      verdict(),
      verdict({ queryId: "q2", score: null, error: "429" }),
    ]);
    expect([...keys]).toEqual([setVerdictKey("q1", "exa", "j1")]);
  });

  it("last write wins, and errored rows never reach the summary", () => {
    const rows = dedupeSetVerdictRows([
      verdict({ score: 3 }),
      verdict({ score: 9 }),
      verdict({ queryId: "q2", error: "429" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(9);
  });

  it("a null score survives dedupe — it is counted, not dropped", () => {
    expect(dedupeSetVerdictRows([verdict({ score: null })])).toHaveLength(1);
  });
});

describe("set scores in the summary follow the same failure rules as rungs", () => {
  const meta = (setVerdicts: PooledSetVerdictRow[]) => ({ judges: ["j1"], now: 0, setVerdicts });

  it("a provider-fault failure is a miss scored 0, not a dropped row", () => {
    const s = summarizePooled(
      [
        fetchRow(),
        fetchRow({ queryId: "q2", urls: [], sources: [], error: "500", error_stage: "provider" }),
      ],
      [],
      meta([verdict({ score: 10 })]),
    );
    const stat = s.by_provider_set[0];
    expect(stat.n_misses).toBe(1);
    expect(stat.n_queries).toBe(2);
    expect(stat.mean_score).toBe(5); // (10 + 0) / 2
  });

  it("an our-fault failure is excluded and published, never scored", () => {
    const s = summarizePooled(
      [
        fetchRow(),
        fetchRow({ queryId: "q2", urls: [], sources: [], error: "our judge died", error_stage: "judge" }),
      ],
      [],
      meta([verdict({ score: 6 })]),
    );
    const stat = s.by_provider_set[0];
    expect(stat.n_excluded).toBe(1);
    expect(stat.n_misses).toBe(0);
    expect(stat.n_queries).toBe(1);
    expect(stat.mean_score).toBe(6);
  });

  it("a set no judge could grade is excluded — not a measurement, and not a zero", () => {
    const s = summarizePooled([fetchRow()], [], meta([verdict({ score: null })]));
    const stat = s.by_provider_set[0];
    expect(stat.n_excluded).toBe(1);
    expect(stat.n_queries).toBe(0);
    expect(s.n_set_null_scores).toBe(1);
  });

  it("several judges on one set average before the query enters the mean", () => {
    const s = summarizePooled(
      [fetchRow()],
      [],
      { judges: ["j1", "j2"], now: 0, setVerdicts: [verdict({ score: 4 }), verdict({ judge: "j2", score: 8 })] },
    );
    expect(s.by_provider_set[0].mean_score).toBe(6);
    expect(s.by_provider_set[0].n_queries).toBe(1);
  });

  it("a run that never asked for set judging reports no set block at all", () => {
    const s = summarizePooled([fetchRow()], [], { judges: ["j1"], now: 0 });
    expect(s.by_provider_set).toEqual([]);
    expect(s.n_set_verdicts).toBe(0);
  });
});
