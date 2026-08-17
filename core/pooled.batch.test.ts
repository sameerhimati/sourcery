import { describe, expect, it, vi } from "vitest";

// The claim batching rests on: a batch result maps back onto the same
// append-only log purely by resume key, so --resume needs no changes. These
// pin that, plus the unordered-results contract both labs warn about.
const submitted: { customId: string; model: string }[] = [];
vi.mock("./llm/batch", () => ({
  supportsBatch: () => true,
  completeBatch: vi.fn(async (reqs: { customId: string; args: { model: string } }[]) => {
    reqs.forEach((r) => submitted.push({ customId: r.customId, model: r.args.model }));
    // Deliberately reversed: results come back in any order, and the caller
    // must key by custom_id rather than position.
    return [...reqs].reverse().map((r, i) =>
      i === 0
        ? { customId: r.customId, error: "provider said no" }
        : { customId: r.customId, text: '{"rung": 2, "rationale": "ok"}' },
    );
  }),
}));

const { judgementKey, runPooledJudging, runSetJudging, setVerdictKey } = await import("./pooled");
type PooledPage = import("./pool").PooledPage;
type PooledFetchRow = import("./pooled").PooledFetchRow;

const page = (url: string): PooledPage => ({
  queryId: "q1", query: "Q?", url, domain: "d.com", title: "t",
  published: "2026-01-01", content: "body", content_from: "exa" as never,
  returned_by: ["exa"] as never,
});

describe("runPooledJudging — batch path", () => {
  it("uses the resume key as the batch id, which is what makes resume work untouched", async () => {
    submitted.length = 0;
    await runPooledJudging([page("https://a.com/1")], ["openai/m"], { batch: true });
    expect(submitted[0].customId).toBe(judgementKey("q1", "https://a.com/1", "m"));
  });

  it("matches results by id even when the provider returns them reversed", async () => {
    const rows = await runPooledJudging(
      [page("https://a.com/1"), page("https://a.com/2"), page("https://a.com/3")],
      ["openai/m"],
      { batch: true },
    );
    // The mock errors whichever came back first — the LAST one submitted.
    const errored = rows.filter((r) => r.error);
    expect(errored).toHaveLength(1);
    expect(errored[0].url).toBe("https://a.com/3");
    expect(rows.filter((r) => r.rung === 2)).toHaveLength(2);
  });

  it("still calls onRow for every request, so persistence is unchanged", async () => {
    const seen: string[] = [];
    await runPooledJudging([page("https://a.com/1"), page("https://a.com/2")], ["openai/m"], {
      batch: true,
      onRow: (r) => seen.push(r.url),
    });
    expect(seen).toEqual(["https://a.com/1", "https://a.com/2"]);
  });

  it("a batch error becomes an ordinary errored row, which resume retries", async () => {
    const rows = await runPooledJudging([page("https://a.com/1")], ["openai/m"], { batch: true });
    expect(rows[0]).toMatchObject({ rung: null, error: "provider said no" });
  });
});

describe("runSetJudging — batch path", () => {
  const row = (queryId: string): PooledFetchRow => ({
    queryId, type: "how_to", query: "Q?", provider: "exa",
    num_sources: 1, num_extracted: 1, urls: ["https://a.com/1"],
    sources: [{ title: "A", url: "https://a.com/1", domain: "a.com", snippet: "", content: "body" }] as never,
  });

  it("keys on setVerdictKey, which includes the provider", async () => {
    submitted.length = 0;
    await runSetJudging([row("q1")], ["openai/m"], { batch: true });
    expect(submitted[0].customId).toBe(setVerdictKey("q1", "exa", "m"));
  });

  it("parses scores on the 0–10 scale, not the rung scale", async () => {
    const rows = await runSetJudging([row("q1"), row("q2")], ["openai/m"], { batch: true });
    // The mock returns {"rung": 2} with no "score" — a set verdict must read
    // that as null rather than inventing a 2.
    expect(rows.every((r) => r.score === null)).toBe(true);
  });
});
