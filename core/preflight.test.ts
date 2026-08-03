import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { budgetBlock, estimate, renderEstimate, type Estimate } from "./preflight";
import { DEFAULT_CONFIG } from "./types";

// The point of this module is that a run says what it costs BEFORE it spends
// anything, having failed to once already. So these tests care about two things:
// the arithmetic being right, and the refusal being on the PESSIMISTIC end — a
// run that only fits if every page scrapes cleanly is a run that strands itself.

const BALANCE = vi.fn<() => Promise<number | null>>();

vi.mock("./adapters", () => ({
  getAdapter: (id: string) => {
    if (id === "firecrawl") {
      return {
        id,
        cost: {
          // 20 credits/arm at the default config, measured 2026-07-29.
          perArm: () => 20,
          balance: BALANCE,
          hardTargetMultiplier: 3,
          unit: "credits",
        },
      };
    }
    if (id === "nope") throw new Error(`Unknown provider "${id}".`);
    return { id }; // tavily / exa / bright_data / plain: no cost model
  },
}));

beforeEach(() => BALANCE.mockResolvedValue(1000));
afterEach(() => vi.clearAllMocks());

describe("estimate", () => {
  it("prices metered arms at floor and 3x pessimistic", async () => {
    const est = await estimate(["firecrawl"], 6, DEFAULT_CONFIG);
    expect(est.lines[0]).toMatchObject({ arms: 6, min: 120, max: 360, unit: "credits" });
    expect(est.totalMin).toBe(120);
    expect(est.totalMax).toBe(360);
  });

  it("charges nothing for providers with no credit model", async () => {
    // Bright Data bills bandwidth; Tavily and Exa have their own quotas; plain is
    // free. None can answer "will this finish?" in one number, so they report
    // null rather than a confident guess.
    const est = await estimate(["tavily", "exa", "plain"], 100, DEFAULT_CONFIG);
    expect(est.lines.map((l) => l.min)).toEqual([null, null, null]);
    expect(est.totalMax).toBe(0);
  });

  it("only the metered provider contributes to a mixed run", async () => {
    // A realistic mixed batch: 4 providers, 6 queries, but only the firecrawl
    // arm costs firecrawl credits.
    const est = await estimate(
      ["firecrawl", "tavily", "exa", "bright_data"],
      6,
      DEFAULT_CONFIG,
    );
    expect(est.totalMin).toBe(120);
    expect(est.totalMax).toBe(360);
  });

  it("accepts per-provider arm counts, for --resume", async () => {
    const est = await estimate(["firecrawl", "tavily"], { firecrawl: 2, tavily: 10 }, DEFAULT_CONFIG);
    expect(est.lines[0]).toMatchObject({ provider: "firecrawl", arms: 2, min: 40 });
    expect(est.lines[1]).toMatchObject({ provider: "tavily", arms: 10, min: null });
  });

  it("flags a provider whose pessimistic cost exceeds its balance", async () => {
    BALANCE.mockResolvedValue(200); // 6 arms could reach 360
    const est = await estimate(["firecrawl"], 6, DEFAULT_CONFIG);
    expect(est.overBalance).toEqual(["firecrawl"]);
  });

  it("does not flag a run that fits even at the pessimistic end", async () => {
    BALANCE.mockResolvedValue(400);
    expect((await estimate(["firecrawl"], 6, DEFAULT_CONFIG)).overBalance).toEqual([]);
  });

  it("reports an unreadable balance as unknown rather than as room to spend", async () => {
    BALANCE.mockResolvedValue(null);
    const est = await estimate(["firecrawl"], 6, DEFAULT_CONFIG);
    expect(est.lines[0].remaining).toBeNull();
    expect(est.overBalance).toEqual([]); // can't claim it won't finish either
  });
});

describe("budgetBlock", () => {
  const est = (min: number, max: number): Estimate =>
    ({ lines: [], totalMin: min, totalMax: max, overBalance: [] });

  it("allows the run when no ceiling was given", () => {
    expect(budgetBlock(est(120, 360))).toBeNull();
  });

  it("blocks on the PESSIMISTIC total, not the floor", () => {
    // 280 is the kind of ceiling you set from a real balance (30% of 932 left).
    // A 6-arm firecrawl batch floors at 120 but can reach 360, so it must be
    // refused — --max-credits is a ceiling the run must not be able to cross,
    // not a figure it probably won't reach.
    const block = budgetBlock(est(120, 360), 280);
    expect(block).toContain("could cost up to 360");
    expect(block).toContain("280");
    expect(block).toContain("floor cost is 120");
  });

  it("allows a run whose worst case fits the ceiling", () => {
    expect(budgetBlock(est(40, 120), 280)).toBeNull();
  });

  it("allows the exact boundary", () => {
    expect(budgetBlock(est(100, 280), 280)).toBeNull();
  });
});

describe("renderEstimate", () => {
  it("shows the range, the balance, and a warning on the at-risk provider", async () => {
    BALANCE.mockResolvedValue(200);
    const out = renderEstimate(await estimate(["firecrawl", "tavily"], 6, DEFAULT_CONFIG));
    expect(out).toContain("120-360 credits");
    expect(out).toContain("200 left");
    expect(out).toContain("MAY NOT FINISH");
    expect(out).toContain("unmetered");
  });

  it("omits the total line when nothing in the run is metered", async () => {
    const out = renderEstimate(await estimate(["tavily", "plain"], 6, DEFAULT_CONFIG));
    expect(out).not.toContain("total:");
  });
});
