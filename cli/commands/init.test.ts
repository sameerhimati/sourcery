import { describe, expect, it } from "vitest";
import { envTemplate, mergeEnv, shortHost, usageGuide } from "./init";
import { invocation } from "../invocation";
import { listAdapters } from "@core/adapters";
import { PROVIDERS as LLM_PROVIDERS } from "@core/llm";

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

describe("envTemplate", () => {
  // Generated rather than copied from .env.example, because `files: ["dist"]`
  // means the example never reaches an npx user. This asserts the generation
  // stays complete, so registering an adapter can't silently omit its key.
  it("lists every key the registered providers and LLM backends need", () => {
    const t = envTemplate();
    for (const spec of listAdapters())
      for (const key of spec.requiredEnv) expect(t).toContain(`${key}=`);
    for (const p of Object.values(LLM_PROVIDERS)) expect(t).toContain(`${p.envKey}=`);
  });

  it("leaves every value blank, so nothing reads as already configured", () => {
    for (const line of envTemplate().split("\n")) {
      if (!line || line.startsWith("#")) continue;
      expect(line).toMatch(/^[A-Z0-9_]+=$/);
    }
  });
});

describe("invocation — the last thing the wizard says must be runnable", () => {
  it("uses the npm script when running from a clone, which is what the README leads with", () => {
    expect(invocation("/Users/x/Code/sourcery/cli/index.ts")).toBe("npm run sourcery --");
    expect(invocation("C:\\src\\sourcery\\cli\\index.ts")).toBe("npm run sourcery --");
  });

  it("uses the bare binary for an installed copy", () => {
    expect(invocation("/usr/local/lib/node_modules/sourcery-eval/dist/index.js")).toBe("sourcery");
    expect(invocation("/tmp/x/node_modules/.bin/sourcery")).toBe("sourcery");
  });

  it("falls back to the binary when argv gives it nothing", () => {
    expect(invocation("")).toBe("sourcery");
  });
});

describe("usageGuide", () => {
  it("names all three commands the README leads with", () => {
    const g = usageGuide("sourcery");
    for (const cmd of ["run", "batch", "report"]) expect(g).toContain(`sourcery ${cmd}`);
  });

  it("spells the commands the way the caller actually invoked the tool", () => {
    // A clone user copying `sourcery run` out of this guide gets
    // command-not-found, which is a bad last impression for a setup wizard.
    expect(usageGuide("npm run sourcery --")).toContain('npm run sourcery -- run "<query>"');
  });

  it("warns that batch spends before it spends", () => {
    expect(usageGuide("sourcery")).toContain("--dry-run");
  });
});

describe("shortHost — the provider menu answers 'where do I get one'", () => {
  it("keeps the menu narrow by showing only the host", () => {
    expect(shortHost("https://www.firecrawl.dev/app/api-keys")).toBe("firecrawl.dev");
    expect(shortHost("https://brightdata.com/cp/setting/users")).toBe("brightdata.com");
    expect(shortHost("https://app.tavily.com/home")).toBe("app.tavily.com");
  });

  it("returns nothing for a provider with no signup, rather than 'undefined'", () => {
    expect(shortHost(undefined)).toBe("");
  });
});

describe("adapter signup links — init offers them before asking for a key", () => {
  it("gives every keyed provider somewhere to go", () => {
    for (const spec of listAdapters()) {
      if (!spec.requiredEnv.length) continue;
      expect(spec.signup, `${spec.id} has no signup URL`).toMatch(/^https:\/\//);
    }
  });

  it("leaves the keyless baseline without one, since there is nothing to sign up for", () => {
    expect(listAdapters().find((s) => s.id === "plain")?.signup).toBeUndefined();
  });
});
