import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnchorSetError, calibrateJudges, parseAnchors } from "./anchors";
import type { PooledPage } from "./pool";

// The anchor set is the mechanism that turns "we think this model is a bad
// judge" into a measurement. Its two hard rules are pinned here: probes must
// expect 0 by construction, and a probe scored above 0 is a disqualifying
// failure, not a rounding error.

const shipped = readFileSync(
  fileURLToPath(new URL("../datasets/anchors.json", import.meta.url)),
  "utf8",
);

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    kind: "anchor",
    query: "Q?",
    page: { title: "t", domain: "d", url: "u", published: null, content: "some page text" },
    expected_rung: 2,
    note: "settled because …",
    ...over,
  };
}

describe("parseAnchors", () => {
  it("accepts the shipped example file", () => {
    const anchors = parseAnchors(shipped);
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    expect(anchors.some((a) => a.kind === "probe")).toBe(true);
  });

  it("rejects a probe whose expected rung is not 0", () => {
    expect(() =>
      parseAnchors(JSON.stringify([entry({ kind: "probe", expected_rung: 2 })])),
    ).toThrow(AnchorSetError);
  });

  it("rejects an entry with no note — the rating must be arguable", () => {
    expect(() => parseAnchors(JSON.stringify([entry({ note: "" })]))).toThrow(AnchorSetError);
  });

  it("rejects an out-of-scale expected rung", () => {
    expect(() => parseAnchors(JSON.stringify([entry({ expected_rung: 7 })]))).toThrow(
      AnchorSetError,
    );
  });
});

describe("calibrateJudges", () => {
  const anchors = parseAnchors(
    JSON.stringify([
      entry({ id: "a1", expected_rung: 3 }),
      entry({ id: "a2", expected_rung: 1 }),
      entry({ id: "p1", kind: "probe", expected_rung: 0 }),
    ]),
  );

  it("scores a faithful judge clean and a keyword-fooled judge as disqualified", async () => {
    // The faithful judge returns the expected rung; the fooled one rates the
    // probe a 3 because the keywords are all there.
    const judgeFn = async (page: PooledPage, model: string) => {
      const anchor = anchors.find((a) => a.id === page.queryId)!;
      if (model === "faithful") return { rung: anchor.expected_rung, rationale: "" };
      return { rung: anchor.kind === "probe" ? 3 : anchor.expected_rung, rationale: "" };
    };
    const [faithful, fooled] = await calibrateJudges(anchors, ["faithful", "fooled"], {
      judgeFn,
    });
    expect(faithful.exact_rate).toBe(1);
    expect(faithful.probe_failures).toHaveLength(0);
    expect(fooled.probe_failures).toHaveLength(1);
    expect(fooled.probe_failures[0].got).toBe(3);
    expect(fooled.mean_abs_dev).toBeGreaterThan(faithful.mean_abs_dev);
  });

  it("counts a judge that returns no rung instead of averaging it in", async () => {
    const judgeFn = async () => ({ rung: null, rationale: "unparseable" });
    const [judge] = await calibrateJudges(anchors, ["broken"], { judgeFn });
    expect(judge.n_null).toBe(3);
    expect(judge.exact_rate).toBe(0);
  });
});
