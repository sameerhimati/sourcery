import { describe, expect, it } from "vitest";
import { mergeEnv } from "./init";

// mergeEnv writes the file that holds every credential the user owns. The only
// unforgivable bug here is destroying a key it didn't ask about, so that is what
// these tests are for.

describe("mergeEnv", () => {
  it("appends a new key", () => {
    const { content, wrote } = mergeEnv("# header\n", { TAVILY_API_KEY: "tvly-x" });
    expect(content).toBe("# header\nTAVILY_API_KEY=tvly-x\n");
    expect(wrote).toEqual(["TAVILY_API_KEY"]);
  });

  it("never overwrites a key that already holds a value", () => {
    // Re-running init to add one provider must not cost you the others.
    const existing = "OPENAI_API_KEY=sk-original\n";
    const { content, wrote, kept } = mergeEnv(existing, { OPENAI_API_KEY: "sk-new" });
    expect(content).toBe(existing);
    expect(wrote).toEqual([]);
    expect(kept).toEqual(["OPENAI_API_KEY"]);
  });

  it("fills a key that exists but is empty", () => {
    // The state OPENAI_API_KEY was actually in: present as a placeholder, no
    // value. Treating that as "already set" would make init unable to fix it.
    const { content, wrote } = mergeEnv("OPENAI_API_KEY=\n", { OPENAI_API_KEY: "sk-real" });
    expect(content).toContain("OPENAI_API_KEY=sk-real");
    expect(wrote).toEqual(["OPENAI_API_KEY"]);
  });

  it("preserves unrelated keys, comments and blank lines verbatim", () => {
    const existing = "# LLM\nFIREWORKS_API_KEY=fw-1\n\n# retrieval\nFIRECRAWL_API_KEY=fc-1\n";
    const { content } = mergeEnv(existing, { EXA_API_KEY: "exa-1" });
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain("EXA_API_KEY=exa-1");
  });

  it("skips empty values rather than writing a blank assignment", () => {
    // A user who hits enter at a key prompt gets nothing written, not `KEY=`.
    const { content, wrote } = mergeEnv("", { TAVILY_API_KEY: "", EXA_API_KEY: "e" });
    expect(content).not.toContain("TAVILY_API_KEY");
    expect(wrote).toEqual(["EXA_API_KEY"]);
  });

  it("adds a trailing newline before appending to a file without one", () => {
    const { content } = mergeEnv("FIREWORKS_API_KEY=fw-1", { EXA_API_KEY: "e" });
    expect(content).toBe("FIREWORKS_API_KEY=fw-1\nEXA_API_KEY=e\n");
  });

  it("handles several keys in one pass, splitting written from kept", () => {
    const { wrote, kept } = mergeEnv("FIRECRAWL_API_KEY=fc-1\n", {
      FIRECRAWL_API_KEY: "fc-2",
      TAVILY_API_KEY: "tv-1",
      EXA_API_KEY: "exa-1",
    });
    expect(kept).toEqual(["FIRECRAWL_API_KEY"]);
    expect(wrote).toEqual(["TAVILY_API_KEY", "EXA_API_KEY"]);
  });
});
