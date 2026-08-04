import { describe, expect, it } from "vitest";
import { parseQuerySet, QuerySetError, QUERY_TYPES, querySetTemplate } from "./query-set";

// This is the first file a new user hand-writes, so every failure mode needs an
// error that names the entry and the fix. A stack trace here reads as "the tool
// is broken" rather than "line 3 has a typo".

const ok = [{ id: "a", type: "how_to", query: "how do I rotate a Postgres credential" }];

describe("parseQuerySet — formats", () => {
  it("reads a JSON array, which is what you hand-write", () => {
    expect(parseQuerySet(JSON.stringify(ok))).toEqual(ok);
  });

  it("reads JSONL, which is what falls out of a query log", () => {
    const jsonl = ok.map((q) => JSON.stringify(q)).join("\n");
    expect(parseQuerySet(jsonl)).toEqual(ok);
  });

  it("ignores blank lines and // comments in JSONL", () => {
    const text = `// my real queries\n${JSON.stringify(ok[0])}\n\n`;
    expect(parseQuerySet(text)).toHaveLength(1);
  });

  it("generates ids when you didn't write any", () => {
    const parsed = parseQuerySet(JSON.stringify([{ type: "how_to", query: "a" }, { type: "how_to", query: "b" }]));
    expect(parsed.map((q) => q.id)).toEqual(["q-01", "q-02"]);
  });

  it("keeps an optional note", () => {
    const parsed = parseQuerySet(JSON.stringify([{ type: "how_to", query: "a", note: "why this one" }]));
    expect(parsed[0].note).toBe("why this one");
  });
});

describe("parseQuerySet — rejections name the fix", () => {
  const failsWith = (text: string, pattern: RegExp) => {
    let msg = "";
    try {
      parseQuerySet(text, "my-queries.json");
    } catch (e) {
      expect(e).toBeInstanceOf(QuerySetError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(pattern);
    expect(msg).toContain("my-queries.json");
  };

  it("rejects an unknown type and lists the valid ones", () => {
    // The six are load-bearing: the heatmap, the MCP classifier and
    // which_provider's routing all key off them. A seventh would parse here and
    // then be unroutable forever, so it has to be refused at the door.
    failsWith(JSON.stringify([{ type: "shopping", query: "a" }]), /how_to/);
  });

  it("rejects a missing query", () => {
    failsWith(JSON.stringify([{ type: "how_to" }]), /no `query`/);
  });

  it("rejects an empty query rather than running a blank arm", () => {
    failsWith(JSON.stringify([{ type: "how_to", query: "   " }]), /no `query`/);
  });

  it("rejects duplicate ids, which would merge two queries into one row", () => {
    const dup = JSON.stringify([
      { id: "x", type: "how_to", query: "a" },
      { id: "x", type: "how_to", query: "b" },
    ]);
    failsWith(dup, /reuses the id/);
  });

  it("rejects an empty file", () => {
    failsWith("   ", /is empty/);
  });

  it("rejects malformed JSON with a hint about what usually causes it", () => {
    failsWith('[{"type": "how_to",}]', /trailing comma/);
  });

  it("names the offending entry, not just the file", () => {
    const text = JSON.stringify([
      { type: "how_to", query: "fine" },
      { type: "how_to", query: "also fine" },
      { type: "nope", query: "bad" },
    ]);
    failsWith(text, /query 3/);
  });
});

describe("querySetTemplate", () => {
  it("parses as a valid query set, so the starting point actually starts", () => {
    expect(() => parseQuerySet(querySetTemplate())).not.toThrow();
  });

  it("covers every type, so nobody has to look the list up", () => {
    const types = new Set(parseQuerySet(querySetTemplate()).map((q) => q.type));
    expect([...types].sort()).toEqual([...QUERY_TYPES].sort());
  });

  it("is real retrieval work, not more freshness probes", () => {
    // The built-in 48 are all "what is the latest X". findings.md argues at
    // length that this is the dataset's weakness, so the template someone copies
    // must not reproduce it.
    const queries = parseQuerySet(querySetTemplate()).map((q) => q.query);
    expect(queries.every((q) => q.includes("<"))).toBe(true);
    expect(queries.filter((q) => /latest|newest/i.test(q))).toHaveLength(0);
  });
});
