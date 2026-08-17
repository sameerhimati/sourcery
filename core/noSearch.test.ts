import { describe, expect, it, vi } from "vitest";

// Mocked at the LLM boundary so the baseline's own rules are tested without a
// call: what a verdict means, how ties resolve, and which questions come out
// labelled as ones retrieval could never have helped with.
vi.mock("./llm", () => ({
  complete: vi.fn(async ({ messages }: { messages: { role: string; content: string }[] }) => {
    const user = messages[messages.length - 1].content;
    if (user.startsWith("Question:")) return '{"verdict": "knew", "rationale": "correct"}';
    return "an answer written from memory";
  }),
  requiredEnvKeys: () => [],
}));

const {
  dedupeNoSearchRows,
  noSearchKey,
  parseNoSearchGrade,
  resumableNoSearchKeys,
  runNoSearchBaseline,
  summarizeNoSearch,
} = await import("./noSearch");
type NoSearchRow = import("./noSearch").NoSearchRow;

function row(over: Partial<NoSearchRow> = {}): NoSearchRow {
  return {
    queryId: "q1",
    query: "Q?",
    model: "m",
    grader: "g1",
    answer: "a",
    verdict: "knew",
    rationale: "",
    ...over,
  };
}

describe("parseNoSearchGrade", () => {
  it("accepts each of the four verdicts", () => {
    for (const v of ["knew", "partial", "wrong", "unknown"]) {
      expect(parseNoSearchGrade(`{"verdict": "${v}"}`).verdict).toBe(v);
    }
  });

  it("is not fussy about case or stray whitespace", () => {
    expect(parseNoSearchGrade('{"verdict": " Knew "}').verdict).toBe("knew");
  });

  it("an unrecognised verdict is null, not quietly read as unknown", () => {
    // "unknown" is a real finding — the model admitted ignorance. A broken
    // grader must never be able to manufacture that finding.
    const g = parseNoSearchGrade('{"verdict": "maybe"}');
    expect(g.verdict).toBeNull();
    expect(g.rationale).toMatch(/unrecognised/);
  });

  it("unparseable output is null and says so", () => {
    expect(parseNoSearchGrade("hard to say really").verdict).toBeNull();
  });
});

describe("runNoSearchBaseline", () => {
  const queries = [
    { id: "q1", type: "how_to" as const, query: "Q1?", note: "Correct: the thing." },
    { id: "q2", type: "how_to" as const, query: "Q2?", note: "Correct: another thing." },
  ];

  it("grades every question with every grader", async () => {
    const rows = await runNoSearchBaseline(queries, ["g1", "g2"], { model: "m" });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.verdict === "knew")).toBe(true);
  });

  it("writes one answer per question and reuses it across graders", async () => {
    // Graders must grade the same text, or their disagreement is about two
    // different answers rather than about the question.
    const rows = await runNoSearchBaseline(queries, ["g1", "g2"], { model: "m" });
    const forQ1 = rows.filter((r) => r.queryId === "q1");
    expect(new Set(forQ1.map((r) => r.answer)).size).toBe(1);
  });

  it("skips work already on disk", async () => {
    const done = new Set([noSearchKey("q1", "g1")]);
    const rows = await runNoSearchBaseline(queries, ["g1"], { model: "m", done });
    expect(rows.map((r) => r.queryId)).toEqual(["q2"]);
  });

  it("records the model that answered, so the control is reproducible", async () => {
    const rows = await runNoSearchBaseline([queries[0]], ["g1"], { model: "some-model" });
    expect(rows[0].model).toBe("some-model");
  });
});

describe("baseline log hygiene", () => {
  it("resume keeps landed rows and retries errored ones", () => {
    const keys = resumableNoSearchKeys([row(), row({ queryId: "q2", error: "429" })]);
    expect([...keys]).toEqual([noSearchKey("q1", "g1")]);
  });

  it("last write wins and errored rows never reach the summary", () => {
    const rows = dedupeNoSearchRows([
      row({ verdict: "wrong" }),
      row({ verdict: "knew" }),
      row({ queryId: "q2", error: "429" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("knew");
  });
});

describe("summarizeNoSearch — which questions retrieval could never have helped with", () => {
  const meta = { model: "m", graders: ["g1", "g2", "g3"] };

  it("a question every grader says the model knew is flagged as already known", () => {
    const s = summarizeNoSearch(
      [row({ grader: "g1" }), row({ grader: "g2" }), row({ grader: "g3" })],
      meta,
    );
    expect(s.already_known).toEqual(["q1"]);
    expect(s.counts.knew).toBe(1);
  });

  it("a split panel does NOT certify a question as already known", () => {
    // knew must win outright: writing a question off as undiscriminating is a
    // claim that shrinks the measurable difference between providers, so it
    // needs more than a plurality.
    const s = summarizeNoSearch(
      [row({ grader: "g1", verdict: "knew" }), row({ grader: "g2", verdict: "unknown" })],
      meta,
    );
    expect(s.already_known).toEqual([]);
  });

  it("a confidently wrong answer surfaces rather than hiding behind unknown", () => {
    const s = summarizeNoSearch(
      [row({ grader: "g1", verdict: "wrong" }), row({ grader: "g2", verdict: "unknown" })],
      meta,
    );
    expect(s.confidently_wrong).toEqual(["q1"]);
  });

  it("an unusable grade is counted and excluded, never read as a verdict", () => {
    const s = summarizeNoSearch([row({ verdict: null })], meta);
    expect(s.n_ungraded).toBe(1);
    expect(s.n_questions).toBe(0);
    expect(s.already_known).toEqual([]);
  });

  it("errors are reported from the raw rows, not silently deduped away", () => {
    const s = summarizeNoSearch([row(), row({ queryId: "q2", error: "429" })], meta);
    expect(s.n_errors).toBe(1);
    expect(s.n_questions).toBe(1);
  });

  it("a question nothing could answer should come back unknown, not knew", () => {
    // The honesty check: on the unanswerable eight, "unknown" is the pass.
    const s = summarizeNoSearch(
      [
        row({ queryId: "r2u-01", grader: "g1", verdict: "unknown" }),
        row({ queryId: "r2u-01", grader: "g2", verdict: "unknown" }),
      ],
      meta,
    );
    expect(s.counts.unknown).toBe(1);
    expect(s.already_known).toEqual([]);
    expect(s.confidently_wrong).toEqual([]);
  });
});
