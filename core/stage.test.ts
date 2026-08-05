import { describe, expect, it, vi } from "vitest";
import type { Source } from "@core/types";

// ─── who a failure belongs to ───
// The published table reported Exa at 1 provider failure in 240. That row was
// the answer/judge LLM call timing out with the OpenAI SDK's "Request timed
// out.", recorded against an arm stamped with Exa's name. Same defect class as
// counting a 402 as an outage, one layer up — and worse, because the string
// gives no hint of where it came from.

const SOURCES: Source[] = [
  {
    title: "Retrieved fine",
    url: "https://example.com/a",
    published: "2026-08-01",
    domain: "example.com",
    snippet: "snippet",
    content: "body text the judge never got to grade",
  },
];

vi.mock("@core/adapters", () => ({
  fetchSources: vi.fn(async () => ({
    sources: SOURCES,
    context: "context",
    fetched_at: "2026-08-05T00:00:00.000Z",
    from_cache: false,
  })),
  defaultProviders: () => ["exa"],
}));
vi.mock("@core/answer", () => ({ answer: vi.fn(async () => "an answer") }));
vi.mock("@core/retrievalJudge", () => ({
  retrievalJudge: vi.fn(async () => ({ score: 7, rationale: "fine" })),
}));
// The failure under test: the SDK's exact wording, from the step that is NOT
// the thing being measured.
vi.mock("@core/judge", () => ({
  judge: vi.fn(async () => {
    throw new Error("Request timed out.");
  }),
}));

const { runArm } = await import("@core/orchestrator");
const { isProviderFailure } = await import("@core/credibility");

describe("an LLM step that dies inside a provider's arm", () => {
  it("records the stage that actually threw, not the provider", async () => {
    const arm = await runArm(
      { id: "A", provider: "exa", config: { freshness: "all", num_sources: 8, extraction: "clean" } },
      "what is the newest major announcement from OpenAI",
    );
    expect(arm.error).toBe("Request timed out.");
    expect(arm.error_stage).toBe("judge");
  });

  it("keeps the sources the provider did return", async () => {
    // The old catch spread a blank base and published sources: [] — so a fetch
    // that worked was indistinguishable downstream from one that returned
    // nothing, which is the reading that makes a vendor look broken.
    const arm = await runArm(
      { id: "A", provider: "exa", config: { freshness: "all", num_sources: 8, extraction: "clean" } },
      "q",
    );
    expect(arm.sources).toHaveLength(1);
    expect(arm.fetch_ms).toBeTypeOf("number");
  });

  it("is not counted against the provider's reliability", async () => {
    const arm = await runArm(
      { id: "A", provider: "exa", config: { freshness: "all", num_sources: 8, extraction: "clean" } },
      "q",
    );
    // The whole point. Before staging, this string passed every predicate and
    // landed in the failure column of a table comparing four vendors.
    expect(isProviderFailure(arm.error, arm.error_stage)).toBe(false);
    expect(isProviderFailure(arm.error)).toBe(true); // the legacy read, kept as the contrast
  });
});

describe("isProviderFailure with a stage", () => {
  it("clears the provider whenever another stage threw", () => {
    expect(isProviderFailure("Bright Data returned non-JSON", "judge")).toBe(false);
    expect(isProviderFailure("Bright Data returned non-JSON", "answer")).toBe(false);
  });

  it("still blames the provider for its own bad response", () => {
    expect(isProviderFailure("Bright Data returned non-JSON", "provider")).toBe(true);
    expect(isProviderFailure("429 Rate limit reached", "provider")).toBe(true);
  });

  it("never blames the provider for an unplaceable error", () => {
    // "unknown" is the deliberate default. An error we can't attribute is a fact
    // about the harness; charging it to a vendor is how the last one happened.
    expect(isProviderFailure("something odd", "unknown")).toBe(false);
  });

  it("leaves the account and transport rules intact under a provider stage", () => {
    expect(isProviderFailure("Firecrawl 402: Insufficient credits", "provider")).toBe(false);
    expect(isProviderFailure("fetch failed", "provider")).toBe(false);
  });
});
