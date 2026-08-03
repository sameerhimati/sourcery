import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, defaultProviders, getAdapter, listAdapters, missingEnv } from "./index";
import { parseSerp, stripTags } from "./plain";

describe("adapter registry", () => {
  it("keys match each spec's own id", () => {
    for (const [key, spec] of Object.entries(ADAPTERS)) expect(spec.id).toBe(key);
  });

  it("names the known providers when asked for one that isn't", () => {
    expect(() => getAdapter("nope")).toThrow(/Unknown provider "nope"/);
    // The error must be actionable — it lists what IS available.
    expect(() => getAdapter("nope")).toThrow(/firecrawl/);
  });

  it("reports the baseline as needing no credentials", () => {
    expect(getAdapter("plain").requiredEnv).toEqual([]);
    expect(missingEnv("plain")).toEqual([]);
  });

  it("reports which env vars a keyed provider is missing", () => {
    const before = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    expect(missingEnv("tavily")).toEqual(["TAVILY_API_KEY"]);
    process.env.TAVILY_API_KEY = "test-key";
    expect(missingEnv("tavily")).toEqual([]);
    if (before === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = before;
  });

  describe("default provider set", () => {
    // Every keyed adapter's env, so a stray key on the developer's machine
    // can't leak into the answer. Restored after each case.
    const KEYS = [...new Set(listAdapters().flatMap((s) => s.requiredEnv))];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      for (const k of KEYS) delete process.env[k];
    });
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("compares the providers you actually have keys for", () => {
      process.env.TAVILY_API_KEY = "t";
      process.env.EXA_API_KEY = "e";
      expect(defaultProviders()).toEqual(["tavily", "exa"]);
    });

    it("never picks a provider whose keys are only partly set", () => {
      // Bright Data needs three. Two is not enough, and an arm that 401s every
      // call is worse than an arm that isn't there.
      process.env.BRIGHTDATA_API_TOKEN = "t";
      process.env.BRIGHTDATA_SERP_ZONE = "z";
      process.env.FIRECRAWL_API_KEY = "f";
      process.env.TAVILY_API_KEY = "t";
      expect(defaultProviders()).toEqual(["firecrawl", "tavily"]);
    });

    it("adds the keyless baseline only when there'd otherwise be nothing to compare", () => {
      process.env.FIRECRAWL_API_KEY = "f";
      expect(defaultProviders()).toEqual(["firecrawl", "plain"]);
      process.env.EXA_API_KEY = "e";
      expect(defaultProviders()).toEqual(["firecrawl", "exa"]);
    });

    it("falls back to the baseline alone when no keys are set at all", () => {
      expect(defaultProviders()).toEqual(["plain"]);
    });

    it("applies the same rule to a caller-narrowed pool", () => {
      // What `init` does: the user picked these, so don't widen past them.
      process.env.FIRECRAWL_API_KEY = "f";
      process.env.TAVILY_API_KEY = "t";
      expect(defaultProviders(["firecrawl"])).toEqual(["firecrawl", "plain"]);
    });
  });

  it("gives every adapter a label and a blurb for the docs", () => {
    for (const spec of listAdapters()) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.blurb.length).toBeGreaterThan(0);
    }
  });
});

describe("plain: de-tagging", () => {
  it("drops scripts and styles rather than inlining their source", () => {
    const text = stripTags(
      `<div>Hello<script>var x = "not text";</script><style>.a{color:red}</style> world</div>`,
    );
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("not text");
    expect(text).not.toContain("color:red");
  });

  it("decodes entities and turns block ends into line breaks", () => {
    expect(stripTags("<p>A &amp; B</p><p>C</p>")).toBe("A & B\nC");
    expect(stripTags("<p>caf&#233;</p>")).toBe("café");
  });
});

describe("plain: SERP parsing", () => {
  // Trimmed to the exact markup shape the live endpoint returns.
  const html = `
<ul class="results-standard">
<!--rs--><li class="r1"><a href="https://ex.com/a" class="ob"><p class="i"></p></a>
<h2><a class="title" href="https://ex.com/a">First &amp; Best</a></h2>
<p class="s">A <strong>snippet</strong> here.</p></li><!--re-->
<!--rs--><li class="r2"><h2><a class="title" href="https://other.org/b">Second</a></h2>
<p class="s">More text.</p></li><!--re-->
</ul>`;

  it("pulls url, de-tagged title and snippet per result", () => {
    const hits = parseSerp(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://ex.com/a",
      title: "First & Best",
      snippet: "A snippet here.",
    });
    expect(hits[1].url).toBe("https://other.org/b");
  });

  it("returns nothing for a captcha page instead of inventing results", () => {
    expect(parseSerp("<html><title>Captcha</title><body>no</body></html>")).toEqual([]);
  });

  it("skips non-http hrefs", () => {
    expect(parseSerp(`<!--rs--><h2><a href="/relative">x</a></h2><!--re-->`)).toEqual([]);
  });
});

// core/viz.ts duplicates provider labels so it stays client-safe. Duplication
// without a guard drifts, so this is the guard.
describe("viz labels track the registry", () => {
  it("gives every registered adapter matching display identity", async () => {
    const { PROVIDERS } = await import("../viz");
    for (const spec of listAdapters()) {
      expect(PROVIDERS[spec.id], `viz.ts is missing "${spec.id}"`).toBeDefined();
      expect(PROVIDERS[spec.id].label).toBe(spec.label);
    }
  });
});
