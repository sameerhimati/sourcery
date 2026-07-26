import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryType } from "@core/eval-dataset";
import type { Source } from "@core/types";

// ─── Both network seams are faked ───
// Same pattern as core/orchestrator.fixture.test.ts: retrieval and the LLM are
// the only ways out of the process, so mocking them makes the whole MCP surface
// testable without spending a single provider credit.

const SOURCES: Source[] = [
  {
    title: "Source One",
    url: "https://example.com/one",
    published: "2026-07-01",
    domain: "example.com",
    snippet: "snippet one",
    content: "a long extracted body that must never reach the agent's context",
  },
  {
    title: "Source Two",
    url: "https://example.org/two",
    published: null,
    domain: "example.org",
    snippet: "snippet two",
    content: "a second long extracted body",
  },
];

vi.mock("@core/adapters", () => {
  // Declared inside the factory: vi.mock is hoisted above every top-level const.
  const known = ["bright_data", "firecrawl"];
  return {
    fetchSources: vi.fn(async () => ({
      sources: SOURCES,
      context: "context handed to the answering model",
    })),
    DEFAULT_PROVIDERS: known,
    getAdapter: vi.fn((provider: string) => {
      if (!known.includes(provider)) {
        throw new Error(`Unknown provider "${provider}". Known: ${known.join(", ")}`);
      }
      return { id: provider };
    }),
  };
});

vi.mock("@core/llm", () => ({
  // Three different callers share this seam: the query classifier and both
  // judges all ask for JSON, so branch on the system prompt rather than on
  // jsonMode alone.
  complete: vi.fn(async ({ messages }: { messages: { content: string }[] }) =>
    messages[0].content.startsWith("You label a web-search query")
      ? JSON.stringify({ type: "breaking_news" satisfies QueryType })
      : JSON.stringify({ score: 7, rationale: "judge rationale" }),
  ),
}));

// Import AFTER the mocks so the server binds to the fakes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSourceryServer } from "./server";

/** A client wired to a fresh server over the SDK's own in-memory transport. */
async function connect(runsPath?: string): Promise<Client> {
  const server = createSourceryServer(runsPath ? { runsPath } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sourcery-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

// A local history where bright_data wins breaking_news — the opposite of the
// shipped reference table, so "used the user's data" is unambiguous.
function batchLine(provider: string, queryId: string, retrieval: number, answer: number): string {
  return JSON.stringify({
    mode: "batch",
    batchId: "b1",
    ts: "2026-07-24T00:00:00.000Z",
    row: {
      queryId,
      type: "breaking_news",
      query: `query ${queryId}`,
      provider,
      retrieval_score: retrieval,
      answer_score: answer,
      retrieval_rationale: "",
      median_source_age_days: null,
      num_sources: 5,
      num_sources_extracted: 5,
      latency_ms: 100,
    },
  });
}

let dir: string;
let fixtureRuns: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sourcery-mcp-"));
  fixtureRuns = join(dir, "runs.jsonl");
  writeFileSync(
    fixtureRuns,
    [
      batchLine("bright_data", "bn-01", 9, 8),
      batchLine("bright_data", "bn-02", 9, 8),
      batchLine("firecrawl", "bn-01", 4, 6),
      batchLine("firecrawl", "bn-02", 4, 6),
    ].join("\n") + "\n",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sourcery MCP server", () => {
  it("advertises both tools with their input schemas", async () => {
    const { tools } = await (await connect()).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(["evaluate_retrieval", "which_provider"]);

    const evaluate = byName.evaluate_retrieval.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(evaluate.properties).sort()).toEqual(["model", "providers", "query"]);
    expect(evaluate.required).toEqual(["query"]);

    const which = byName.which_provider.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(which.properties).sort()).toEqual(["model", "query"]);
    expect(which.required).toEqual(["query"]);

    // Descriptions are how an agent decides which tool to reach for; the cheap
    // one must not read like the expensive one.
    expect(byName.evaluate_retrieval.description).toMatch(/metered/i);
    expect(byName.which_provider.description).toMatch(/one LLM call/i);
  });

  it("which_provider answers from the user's own runs.jsonl", async () => {
    const res = await callTool(await connect(fixtureRuns), "which_provider", {
      query: "what happened in the Fed meeting today?",
    });
    expect(res.isError).toBeFalsy();

    expect(JSON.parse(res.content[0].text)).toEqual({
      query: "what happened in the Fed meeting today?",
      type: "breaking_news",
      provider: "bright_data",
      retrieval_mean: 9,
      answer_mean: 8,
      n_queries: 2,
      runner_up: "firecrawl",
      margin: 5,
      source: fixtureRuns,
      // No caveat: this IS their data.
    });
  });

  it("which_provider falls back to the shipped reference run, caveat attached", async () => {
    const res = await callTool(await connect(join(dir, "does-not-exist.jsonl")), "which_provider", {
      query: "what happened in the Fed meeting today?",
    });
    expect(res.isError).toBeFalsy();

    const out = JSON.parse(res.content[0].text);
    expect(out).toMatchObject({
      type: "breaking_news",
      provider: "firecrawl", // per docs/s2-summary.json, not the fixture above
      retrieval_mean: 4.17,
      runner_up: "bright_data",
      source: "sourcery reference run",
    });
    expect(out.caveat).toBe(
      "based on our 480-arm bright_data-vs-firecrawl run, not your data — " +
        "run `sourcery batch` to make this yours.",
    );
  });

  it("which_provider classifies with the caller's model when given one", async () => {
    // The default is an OpenAI model, so without this override the tool is
    // unusable for anyone whose key is from anywhere else — which is the
    // majority, BYO-LLM being the selling point.
    const { complete } = await import("@core/llm");
    vi.mocked(complete).mockClear();

    const res = await callTool(await connect(), "which_provider", {
      query: "what happened in the Fed meeting today?",
      model: "fireworks/accounts/fireworks/models/kimi-k2p6",
    });
    expect(res.isError).toBeFalsy();

    expect(vi.mocked(complete)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fireworks/accounts/fireworks/models/kimi-k2p6" }),
    );
  });

  it("evaluate_retrieval returns a compact scorecard, not the raw run", async () => {
    const res = await callTool(await connect(), "evaluate_retrieval", {
      query: "what is the latest OpenAI announcement?",
      providers: ["bright_data", "firecrawl"],
    });
    expect(res.isError).toBeFalsy();

    expect(JSON.parse(res.content[0].text)).toEqual({
      query: "what is the latest OpenAI announcement?",
      answer_model: "gpt-4o-mini",
      judge_model: "gpt-4o-mini",
      winner: "bright_data", // tie on retrieval → first non-errored arm
      arms: [
        {
          provider: "bright_data",
          retrieval_score: 7,
          answer_score: 7,
          retrieval_rationale: "judge rationale",
          num_sources: 2,
          domains: ["example.com", "example.org"],
          latency_ms: expect.any(Number),
        },
        {
          provider: "firecrawl",
          retrieval_score: 7,
          answer_score: 7,
          retrieval_rationale: "judge rationale",
          num_sources: 2,
          domains: ["example.com", "example.org"],
          latency_ms: expect.any(Number),
        },
      ],
    });

    // The point of "compact": no source bodies, no answer text in the agent's context.
    expect(res.content[0].text).not.toContain("extracted body");
  });

  it("evaluate_retrieval rejects an unknown provider by name", async () => {
    const res = await callTool(await connect(), "evaluate_retrieval", {
      query: "anything",
      providers: ["firecrwal"],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("firecrwal");
  });
});
