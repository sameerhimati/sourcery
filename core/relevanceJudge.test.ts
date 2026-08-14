import { describe, expect, it } from "vitest";
import { parseRungVerdict } from "./relevanceJudge";

// A judge that stops returning valid rungs must be loud, not quietly averaged
// in. Run 1 mapped unparseable judge output to score 0, which is
// indistinguishable from a real zero once it's a number — these tests pin the
// fix: anything that isn't a rung comes back null and is counted, not scored.

describe("parseRungVerdict", () => {
  it("accepts each rung on the scale", () => {
    for (const rung of [0, 1, 2, 3]) {
      expect(parseRungVerdict(JSON.stringify({ rung, rationale: "r" }))).toEqual({
        rung,
        rationale: "r",
      });
    }
  });

  it("rounds a fractional rung rather than inventing a fifth category", () => {
    expect(parseRungVerdict('{"rung": 2.4}').rung).toBe(2);
  });

  it("returns null for a rung off the scale — never clamps 7 into a 3", () => {
    expect(parseRungVerdict('{"rung": 7}').rung).toBeNull();
    expect(parseRungVerdict('{"rung": -1}').rung).toBeNull();
  });

  it("returns null, not 0, for prose or garbage", () => {
    expect(parseRungVerdict("The page seems relevant to me.").rung).toBeNull();
    expect(parseRungVerdict('{"score": 8}').rung).toBeNull();
    expect(parseRungVerdict("{}").rung).toBeNull();
  });
});
