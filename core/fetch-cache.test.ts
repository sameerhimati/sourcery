import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_TTL_MS,
  cacheKey,
  cacheStats,
  readCached,
  setCacheEnabled,
  writeCached,
} from "./fetch-cache";
import { DEFAULT_CONFIG, type FetchResult } from "./types";

const result: FetchResult = {
  sources: [{ title: "T", url: "https://e.com/a", published: null, domain: "e.com" }],
  context: "ctx",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sourcery-cache-"));
  setCacheEnabled(true);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setCacheEnabled(true);
});

describe("cacheKey", () => {
  it("separates seeds, so a credibility run still measures fetch variance", () => {
    // The point of seeds=5 is the spread between five INDEPENDENT fetches. If
    // they shared a cache entry, seed_std_mean would collapse to 0 and the run
    // would report perfect stability it never measured.
    const a = cacheKey("firecrawl", "q", DEFAULT_CONFIG, 0);
    const b = cacheKey("firecrawl", "q", DEFAULT_CONFIG, 1);
    expect(a).not.toBe(b);
  });

  it("separates provider, query, and every config knob", () => {
    const base = cacheKey("firecrawl", "q", DEFAULT_CONFIG, 0);
    expect(cacheKey("bright_data", "q", DEFAULT_CONFIG, 0)).not.toBe(base);
    expect(cacheKey("firecrawl", "other", DEFAULT_CONFIG, 0)).not.toBe(base);
    expect(cacheKey("firecrawl", "q", { ...DEFAULT_CONFIG, num_sources: 3 }, 0)).not.toBe(base);
    expect(cacheKey("firecrawl", "q", { ...DEFAULT_CONFIG, freshness: "24h" }, 0)).not.toBe(base);
    expect(cacheKey("firecrawl", "q", { ...DEFAULT_CONFIG, extraction: "raw" }, 0)).not.toBe(base);
  });

  it("is stable across config property order", () => {
    const reordered = {
      extraction: DEFAULT_CONFIG.extraction,
      num_sources: DEFAULT_CONFIG.num_sources,
      freshness: DEFAULT_CONFIG.freshness,
    };
    expect(cacheKey("firecrawl", "q", reordered, 0)).toBe(
      cacheKey("firecrawl", "q", DEFAULT_CONFIG, 0),
    );
  });
});

describe("round trip", () => {
  it("returns a fetch written moments ago", () => {
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, new Date().toISOString(), dir);
    const hit = readCached("firecrawl", "q", DEFAULT_CONFIG, 0, Date.now(), dir);
    expect(hit?.context).toBe("ctx");
    expect(hit?.sources).toHaveLength(1);
  });

  it("reports fetched_at so a reused fetch is never mistaken for a live one", () => {
    const when = new Date(Date.now() - 60_000).toISOString();
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, when, dir);
    expect(readCached("firecrawl", "q", DEFAULT_CONFIG, 0, Date.now(), dir)?.fetched_at).toBe(when);
  });

  it("misses on a different query", () => {
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, new Date().toISOString(), dir);
    expect(readCached("firecrawl", "other", DEFAULT_CONFIG, 0, Date.now(), dir)).toBeNull();
  });
});

describe("expiry", () => {
  // Every dataset query asks for the LATEST thing and the eval publishes median
  // source age. Serving a week-old fetch would quietly inflate that number.
  it("expires just past the 24h TTL", () => {
    const now = Date.now();
    const when = new Date(now - CACHE_TTL_MS - 1000).toISOString();
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, when, dir);
    expect(readCached("firecrawl", "q", DEFAULT_CONFIG, 0, now, dir)).toBeNull();
  });

  it("still serves just inside the TTL", () => {
    const now = Date.now();
    const when = new Date(now - CACHE_TTL_MS + 60_000).toISOString();
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, when, dir);
    expect(readCached("firecrawl", "q", DEFAULT_CONFIG, 0, now, dir)).not.toBeNull();
  });

  it("rejects an entry stamped in the future rather than trusting it forever", () => {
    const now = Date.now();
    const when = new Date(now + 60 * 60 * 1000).toISOString();
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, when, dir);
    expect(readCached("firecrawl", "q", DEFAULT_CONFIG, 0, now, dir)).toBeNull();
  });
});

describe("robustness", () => {
  // The cache may only ever save money. It must never be the reason a run fails.
  it("treats a corrupt entry as a miss, not an error", () => {
    const key = cacheKey("firecrawl", "q", DEFAULT_CONFIG, 0);
    writeFileSync(join(dir, `${key}.json`), "{not json");
    expect(() => readCached("firecrawl", "q", DEFAULT_CONFIG, 0, Date.now(), dir)).not.toThrow();
    expect(readCached("firecrawl", "q", DEFAULT_CONFIG, 0, Date.now(), dir)).toBeNull();
  });

  it("survives an unwritable directory without losing the run", () => {
    expect(() =>
      writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, new Date().toISOString(), "/proc/x/y"),
    ).not.toThrow();
  });

  it("reads a missing cache directory as empty", () => {
    expect(readCached("firecrawl", "q", DEFAULT_CONFIG, 0, Date.now(), join(dir, "nope"))).toBeNull();
    expect(cacheStats(Date.now(), join(dir, "nope"))).toEqual({ live: 0, expired: 0 });
  });
});

describe("--no-cache", () => {
  it("neither reads nor writes when disabled", () => {
    setCacheEnabled(false);
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, new Date().toISOString(), dir);
    expect(readdirSync(dir)).toHaveLength(0);

    setCacheEnabled(true);
    writeCached("firecrawl", "q", DEFAULT_CONFIG, result, 0, new Date().toISOString(), dir);
    setCacheEnabled(false);
    expect(readCached("firecrawl", "q", DEFAULT_CONFIG, 0, Date.now(), dir)).toBeNull();
  });
});

describe("cacheStats", () => {
  it("counts live and expired separately", () => {
    const now = Date.now();
    writeCached("firecrawl", "a", DEFAULT_CONFIG, result, 0, new Date(now).toISOString(), dir);
    writeCached(
      "firecrawl",
      "b",
      DEFAULT_CONFIG,
      result,
      0,
      new Date(now - CACHE_TTL_MS - 1000).toISOString(),
      dir,
    );
    expect(cacheStats(now, dir)).toEqual({ live: 1, expired: 1 });
  });
});
