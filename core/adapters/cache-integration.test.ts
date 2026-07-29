import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type FetchResult } from "../types";
import { setCacheDir, setCacheEnabled } from "../fetch-cache";

// ─── the claim this file exists to prove ───
// The cache is worth its complexity only if the SECOND fetch makes no provider
// call. Everything else about it is unit-tested in fetch-cache.test.ts; what can
// only be checked here is that `fetchSources` — the seam both `runArm` and the
// credibility matrix go through — actually short-circuits before reaching the
// adapter. A regression here costs real credits silently, which is exactly the
// failure mode that drained a 5000/mo Firecrawl plan.

let calls = 0;

vi.mock("./firecrawl", () => ({
  fetchFirecrawl: (): Promise<FetchResult> => {
    calls++;
    return Promise.resolve({
      sources: [{ title: "T", url: "https://e.com/a", published: null, domain: "e.com" }],
      context: "ctx",
    });
  },
  firecrawlHealth: () => Promise.resolve("ok"),
}));

let dir: string;
beforeEach(() => {
  calls = 0;
  dir = mkdtempSync(join(tmpdir(), "sourcery-cache-int-"));
  setCacheDir(dir);
  setCacheEnabled(true);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setCacheEnabled(true);
});

describe("fetchSources + cache", () => {
  it("calls the provider once across two identical fetches", async () => {
    const { fetchSources } = await import("./index");

    const first = await fetchSources("firecrawl", "same query", DEFAULT_CONFIG);
    expect(calls).toBe(1);
    expect(first.from_cache).toBe(false);
    expect(first.fetched_at).toBeTruthy();

    const second = await fetchSources("firecrawl", "same query", DEFAULT_CONFIG);
    expect(calls).toBe(1); // ← the whole point: no second provider call
    expect(second.from_cache).toBe(true);
    expect(second.context).toBe("ctx");
    // A reused fetch reports when it was ORIGINALLY retrieved, so source-age
    // metrics computed off it stay honest.
    expect(second.fetched_at).toBe(first.fetched_at);
  });

  it("calls the provider again for a different seed", async () => {
    const { fetchSources } = await import("./index");
    await fetchSources("firecrawl", "q", DEFAULT_CONFIG, 0);
    await fetchSources("firecrawl", "q", DEFAULT_CONFIG, 1);
    // seeds=5 measures the spread across independent fetches; sharing one would
    // report a stability the run never observed.
    expect(calls).toBe(2);
  });

  it("calls the provider every time under --no-cache", async () => {
    const { fetchSources } = await import("./index");
    setCacheEnabled(false);
    await fetchSources("firecrawl", "q", DEFAULT_CONFIG);
    await fetchSources("firecrawl", "q", DEFAULT_CONFIG);
    expect(calls).toBe(2);
  });

  it("marks a live fetch from_cache:false even when other entries exist", async () => {
    const { fetchSources } = await import("./index");
    await fetchSources("firecrawl", "a", DEFAULT_CONFIG);
    const other = await fetchSources("firecrawl", "b", DEFAULT_CONFIG);
    expect(other.from_cache).toBe(false);
    expect(calls).toBe(2);
  });
});
