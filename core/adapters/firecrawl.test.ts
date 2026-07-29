import { describe, expect, it } from "vitest";
import { armsAffordable, creditsPerArm } from "./firecrawl";
import { DEFAULT_CONFIG } from "../types";

// These numbers are MEASURED, not derived from docs — see the credit model
// comment in firecrawl.ts. They exist as a test because the previous flat
// estimate was wrong by 2x and nothing caught it, which stranded a 240-arm run
// mid-flight. If Firecrawl changes its billing, this is what should go red.

describe("creditsPerArm", () => {
  it("costs 20 at the default config — the figure measured 2026-07-29", () => {
    // 2 source types × 2 credits/search = 4, plus 8 sources × 2 types × 1 = 16.
    expect(DEFAULT_CONFIG.num_sources).toBe(8);
    expect(DEFAULT_CONFIG.extraction).toBe("clean");
    expect(creditsPerArm(DEFAULT_CONFIG)).toBe(20);
  });

  it("is exactly twice the old flat estimate of 10", () => {
    // The regression this guards: the old model priced one search and one set of
    // scrapes, but the adapter requests sources ["web","news"] — two of each.
    expect(creditsPerArm(DEFAULT_CONFIG)).toBe(10 * 2);
  });

  it("drops to the two searches alone when extraction is off", () => {
    expect(creditsPerArm({ num_sources: 8, extraction: "raw" })).toBe(4);
  });

  it("scales with num_sources, because scrapes are per page", () => {
    expect(creditsPerArm({ num_sources: 3, extraction: "clean" })).toBe(4 + 6);
    expect(creditsPerArm({ num_sources: 12, extraction: "clean" })).toBe(4 + 24);
  });
});

describe("armsAffordable", () => {
  it("reports a range whose optimistic end is the floor cost", () => {
    expect(armsAffordable(1000, DEFAULT_CONFIG)).toEqual({ min: 16, max: 50 });
  });

  it("matches the balance that prompted this fix", () => {
    // 932 credits really is 15-46 arms, not the 93 the old gauge would have said.
    expect(armsAffordable(932, DEFAULT_CONFIG)).toEqual({ min: 15, max: 46 });
    expect(Math.floor(932 / 10)).toBe(93); // what the user used to be told
  });

  it("says zero rather than a fraction when a balance can't fund one arm", () => {
    expect(armsAffordable(10, DEFAULT_CONFIG)).toEqual({ min: 0, max: 0 });
  });
});
