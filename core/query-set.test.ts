import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseQuerySet, QuerySetError, QUERY_TYPES, querySetTemplate } from "./query-set";
import { EVAL_DATASET } from "./eval-dataset";

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

describe("the shipped real-task dataset", () => {
  // datasets/real-tasks.json is the second dataset findings.md promises: real
  // retrieval work, measured beside the synthetic 48 rather than replacing them.
  // It is a hand-written JSON file, so nothing but a test stops it from drifting
  // out of shape between runs — and it is meant to be edited as entities die.
  const raw = readFileSync(
    fileURLToPath(new URL("../datasets/real-tasks.json", import.meta.url)),
    "utf8",
  );

  it("parses through the same loader the CLI uses", () => {
    expect(() => parseQuerySet(raw, "real-tasks.json")).not.toThrow();
  });

  it("is balanced across all six types, so no type carries the result alone", () => {
    const queries = parseQuerySet(raw, "real-tasks.json");
    const counts = new Map<string, number>();
    for (const q of queries) counts.set(q.type, (counts.get(q.type) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...QUERY_TYPES].sort());
    // Equal weight per type: an unbalanced set silently reweights the headline
    // mean toward whichever type happens to have the most rows.
    expect([...new Set(counts.values())]).toEqual([4]);
    expect(queries).toHaveLength(24);
  });

  it("shares no query verbatim with the built-in 48", () => {
    // Only exact restatement is asserted here, and that is deliberate.
    //
    // Three of these tasks shipped as near-duplicates of pl-04, rr-01 and nl-06
    // and were caught by reading them side by side, NOT by a similarity check —
    // a content-word Jaccard scored the MacBook duplicate at 0.18, below any
    // threshold that doesn't also reject unrelated queries sharing one noun.
    // Near-duplication against the 48 is a review step when editing this file
    // (docs/datasets.md says so); pretending a heuristic covers it would be the
    // same mistake as a failure count nobody checked the stage on.
    const builtIn = new Set(EVAL_DATASET.map((q) => q.query.replace(/\s+/g, " ").trim().toLowerCase()));
    const dupes = parseQuerySet(raw, "real-tasks.json")
      .filter((q) => builtIn.has(q.query.replace(/\s+/g, " ").trim().toLowerCase()))
      .map((q) => q.id);
    expect(dupes).toEqual([]);
  });

  it("has no unfilled template placeholders", () => {
    // Placeholders belong in the template, not in a set that gets run for real —
    // "<competitor>" would be sent to four providers verbatim and scored.
    const queries = parseQuerySet(raw, "real-tasks.json");
    expect(queries.filter((q) => q.query.includes("<"))).toHaveLength(0);
  });

  it("carries an acceptance criterion on every task", () => {
    // `note` never reaches the judge — it is how a human re-checks a scored row
    // months later, and how the set stays auditable when an entity changes.
    const queries = parseQuerySet(raw, "real-tasks.json");
    expect(queries.filter((q) => !q.note?.trim())).toHaveLength(0);
  });

  it("uses ids that stay distinguishable from the built-in 48 in a shared log", () => {
    // .sourcery/s2-runs.jsonl has no dataset column: rows from both sets land in
    // the same file and the id prefix is the only thing telling them apart.
    const queries = parseQuerySet(raw, "real-tasks.json");
    expect(queries.filter((q) => !q.id.startsWith("rt-"))).toHaveLength(0);
  });
});
