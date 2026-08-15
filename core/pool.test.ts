import { describe, expect, it } from "vitest";
import { buildPool, normalizeUrl, pairKey, returnedUrls } from "./pool";
import type { Source } from "./types";

// Pooling decides which pages count as "the same page" across providers. A
// false merge credits a provider with a page it never returned; a false split
// judges one page twice and lets it get two different verdicts. Both corrupt
// the scores silently, which is why these cases are pinned.

function src(url: string, over: Partial<Source> = {}): Source {
  return {
    title: "t",
    url,
    published: null,
    domain: new URL(url).hostname,
    ...over,
  };
}

describe("normalizeUrl", () => {
  it("merges the variants that are provably the same page", () => {
    const canonical = normalizeUrl("https://a.com/path");
    expect(normalizeUrl("https://A.COM/path/")).toBe(canonical);
    expect(normalizeUrl("https://a.com/path#section-2")).toBe(canonical);
    expect(normalizeUrl("https://a.com/path?utm_source=x&utm_campaign=y")).toBe(canonical);
    expect(normalizeUrl("https://a.com/path?fbclid=abc")).toBe(canonical);
  });

  it("keeps real query params — they can identify a different page", () => {
    expect(normalizeUrl("https://a.com/p?id=2")).not.toBe(normalizeUrl("https://a.com/p?id=3"));
    expect(normalizeUrl("https://a.com/p?id=2&utm_source=x")).toBe(
      normalizeUrl("https://a.com/p?id=2"),
    );
  });

  it("does not merge www with the bare host — that can be a different site", () => {
    expect(normalizeUrl("https://www.a.com/p")).not.toBe(normalizeUrl("https://a.com/p"));
  });

  it("returns an unparseable URL as-is rather than throwing mid-pool", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("buildPool", () => {
  it("pools the same page from two providers into one pair, remembering both", () => {
    const pool = buildPool([
      { queryId: "q1", query: "Q?", provider: "exa", sources: [src("https://a.com/p")] },
      { queryId: "q1", query: "Q?", provider: "tavily", sources: [src("https://a.com/p/")] },
    ]);
    expect(pool).toHaveLength(1);
    expect(pool[0].returned_by).toEqual(["exa", "tavily"]);
  });

  it("keeps the same URL under two different queries as two pairs", () => {
    const pool = buildPool([
      { queryId: "q1", query: "Q1?", provider: "exa", sources: [src("https://a.com/p")] },
      { queryId: "q2", query: "Q2?", provider: "exa", sources: [src("https://a.com/p")] },
    ]);
    expect(pool).toHaveLength(2);
    expect(pairKey("q1", pool[0].url)).not.toBe(pairKey("q2", pool[1].url));
  });

  it("takes the longest extraction as the page's canonical text, and says whose it was", () => {
    const pool = buildPool([
      {
        queryId: "q1", query: "Q?", provider: "exa",
        sources: [src("https://a.com/p", { content: "short" })],
      },
      {
        queryId: "q1", query: "Q?", provider: "firecrawl",
        sources: [src("https://a.com/p", { content: "a much longer extraction of the page" })],
      },
    ]);
    expect(pool[0].content).toContain("much longer");
    expect(pool[0].content_from).toBe("firecrawl");
  });

  it("fills a missing publish date from any provider that reported one", () => {
    const pool = buildPool([
      { queryId: "q1", query: "Q?", provider: "exa", sources: [src("https://a.com/p")] },
      {
        queryId: "q1", query: "Q?", provider: "tavily",
        sources: [src("https://a.com/p", { published: "2026-08-01" })],
      },
    ]);
    expect(pool[0].published).toBe("2026-08-01");
  });
});

describe("returnedUrls", () => {
  it("dedupes within one provider's result list, keeping order", () => {
    const urls = returnedUrls([
      src("https://a.com/1"),
      src("https://a.com/1#frag"),
      src("https://a.com/2"),
    ]);
    expect(urls).toEqual([normalizeUrl("https://a.com/1"), normalizeUrl("https://a.com/2")]);
  });
});
