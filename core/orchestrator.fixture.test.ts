import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRequest, Source } from "@core/types";

// ─── Zero-behavior-change oracle for the core extraction (S0) ───
// The engine assembles a Run object from two network seams: retrieval
// (fetchSources) and the LLM (openai). We record both seams and snapshot the
// assembled Run. The move src/lib → core/ changes no logic, so this snapshot
// must stay byte-identical before and after — that identity IS the S0 gate.

const RECORDED_SOURCES: Source[] = [
  {
    title: "Recorded Source One",
    url: "https://example.com/one",
    published: "2025-01-15",
    domain: "example.com",
    snippet: "first recorded snippet",
    content: "first recorded source body used for retrieval judging",
  },
  {
    title: "Recorded Source Two",
    url: "https://example.org/two",
    published: null,
    domain: "example.org",
    snippet: "second recorded snippet",
    content: "second recorded source body used for retrieval judging",
  },
];

vi.mock("@core/adapters", () => ({
  // Same recorded retrieval for every provider — provider-invariance is exactly
  // what makes the two arms comparable, and keeps the snapshot deterministic.
  // The cache provenance is pinned to a fixed live fetch: the real fetchSources
  // always sets both, so a mock that omitted them would snapshot a shape the
  // engine never actually produces.
  fetchSources: vi.fn(async () => ({
    sources: RECORDED_SOURCES,
    context: "recorded context handed to the answering model",
    fetched_at: "2026-01-01T00:00:00.000Z",
    from_cache: false,
  })),
  // Pinned rather than re-exported from the real registry: this fixture asserts
  // a byte-identical Run, so the default arms must not change under it when a
  // new adapter is registered — or, now that the default is resolved from the
  // environment, when the machine running the tests happens to hold a key.
  defaultProviders: () => ["bright_data", "firecrawl"],
}));

vi.mock("@core/llm", () => ({
  // Mock the single LLM seam. The judges request JSON (jsonMode), the answer
  // step doesn't — branch on that so one mock serves all three calls
  // deterministically, byte-identical to the pre-provider-layer snapshot.
  complete: vi.fn(async (args: { jsonMode?: boolean }) =>
    args.jsonMode
      ? JSON.stringify({ score: 7, rationale: "recorded judge rationale" })
      : "Recorded answer synthesized from the sources.",
  ),
}));

// Import AFTER the mocks are registered so the engine binds to the fakes.
import { runEval } from "@core/orchestrator";

describe("runEval — recorded fixture (S0 zero-behavior-change gate)", () => {
  beforeEach(() => {
    // Freeze the clock so latency_ms (Date.now delta) is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("assembles a stable Run object from recorded seams", async () => {
    const req: RunRequest = { query: "what changed in the H-1B lottery?" };
    const run = await runEval(req);

    expect(run).toMatchInlineSnapshot(`
      {
        "arms": [
          {
            "answer": "Recorded answer synthesized from the sources.",
            "config": {
              "extraction": "clean",
              "freshness": "all",
              "num_sources": 8,
            },
            "fetched_at": "2026-01-01T00:00:00.000Z",
            "from_cache": false,
            "id": "A",
            "latency_ms": 0,
            "model": "gpt-4o-mini",
            "provider": "bright_data",
            "rationale": "recorded judge rationale",
            "retrieval_rationale": "recorded judge rationale",
            "retrieval_score": 7,
            "score": 7,
            "sources": [
              {
                "content": "first recorded source body used for retrieval judging",
                "domain": "example.com",
                "published": "2025-01-15",
                "snippet": "first recorded snippet",
                "title": "Recorded Source One",
                "url": "https://example.com/one",
              },
              {
                "content": "second recorded source body used for retrieval judging",
                "domain": "example.org",
                "published": null,
                "snippet": "second recorded snippet",
                "title": "Recorded Source Two",
                "url": "https://example.org/two",
              },
            ],
          },
          {
            "answer": "Recorded answer synthesized from the sources.",
            "config": {
              "extraction": "clean",
              "freshness": "all",
              "num_sources": 8,
            },
            "fetched_at": "2026-01-01T00:00:00.000Z",
            "from_cache": false,
            "id": "B",
            "latency_ms": 0,
            "model": "gpt-4o-mini",
            "provider": "firecrawl",
            "rationale": "recorded judge rationale",
            "retrieval_rationale": "recorded judge rationale",
            "retrieval_score": 7,
            "score": 7,
            "sources": [
              {
                "content": "first recorded source body used for retrieval judging",
                "domain": "example.com",
                "published": "2025-01-15",
                "snippet": "first recorded snippet",
                "title": "Recorded Source One",
                "url": "https://example.com/one",
              },
              {
                "content": "second recorded source body used for retrieval judging",
                "domain": "example.org",
                "published": null,
                "snippet": "second recorded snippet",
                "title": "Recorded Source Two",
                "url": "https://example.org/two",
              },
            ],
          },
        ],
        "judge_model": "gpt-4o-mini",
        "query": "what changed in the H-1B lottery?",
        "variable": "provider",
        "winner": "A",
      }
    `);
  });
});
