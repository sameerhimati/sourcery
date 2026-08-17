import { describe, expect, it } from "vitest";
import { parseSetVerdict, renderSources } from "./setJudge";
import type { Source } from "./types";

// The parse rule here is the one relevanceJudge exists to enforce and run 1's
// retrievalJudge gets wrong: a judge that answered with nothing usable must not
// come out as a real 0. These pin it so run 2 can't inherit that bug.

function source(over: Partial<Source> = {}): Source {
  return {
    title: "A page",
    url: "https://example.com/1",
    domain: "example.com",
    snippet: "",
    content: "the body text",
    ...over,
  } as Source;
}

describe("parseSetVerdict", () => {
  it("keeps a valid score and its rationale", () => {
    expect(parseSetVerdict('{"score": 7, "rationale": "solid"}')).toEqual({
      score: 7,
      rationale: "solid",
    });
  });

  it("accepts both ends of the scale", () => {
    expect(parseSetVerdict('{"score": 0}').score).toBe(0);
    expect(parseSetVerdict('{"score": 10}').score).toBe(10);
  });

  it("rounds a fractional score rather than discarding it", () => {
    expect(parseSetVerdict('{"score": 6.4}').score).toBe(6);
  });

  it("a missing score is null, NOT a real zero", () => {
    expect(parseSetVerdict('{"rationale": "no idea"}').score).toBeNull();
  });

  it("an explicit null is null, not Number(null) === 0", () => {
    expect(parseSetVerdict('{"score": null}').score).toBeNull();
  });

  it("an off-scale score is null — 11 is a broken judge, not a great result set", () => {
    expect(parseSetVerdict('{"score": 11}').score).toBeNull();
    expect(parseSetVerdict('{"score": -1}').score).toBeNull();
  });

  it("unparseable output is null and says so", () => {
    const v = parseSetVerdict("I think about a 7 honestly");
    expect(v.score).toBeNull();
    expect(v.rationale).toMatch(/unparseable/);
  });
});

describe("renderSources — blinding survives a set belonging to one provider", () => {
  it("names no provider anywhere in what the judge reads", () => {
    const text = renderSources([
      source({ url: "https://docs.rs/1", domain: "docs.rs" }),
      source({ url: "https://kernel.org/2", domain: "kernel.org" }),
    ]);
    for (const name of ["exa", "firecrawl", "brave", "serper", "perplexity", "parallel"]) {
      expect(text.toLowerCase()).not.toContain(name);
    }
  });

  it("falls back to the snippet when nothing was extracted", () => {
    // Every adapter uses undefined, never "", for a page it couldn't extract —
    // see brightdata.ts / firecrawl.ts / plain.ts. The fallback is written for
    // that shape, and matches textOf() in pool.ts so the per-page judge and
    // this one read the same text for the same page.
    expect(renderSources([source({ content: undefined, snippet: "just a snippet" })])).toContain(
      "just a snippet",
    );
  });

  it("says so plainly when a source has no text at all — Serper returns 756 of these", () => {
    expect(renderSources([source({ content: undefined, snippet: "" })])).toContain(
      "(no content extracted)",
    );
  });

  it("an empty set is stated, not rendered as an empty string", () => {
    expect(renderSources([])).toBe("(no sources retrieved)");
  });
});
