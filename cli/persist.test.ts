import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@core/types";
import { appendRun, readRuns, toRecord } from "./persist";

const RUN: Run = {
  query: "q",
  variable: "provider",
  winner: "A",
  arms: [
    {
      id: "A",
      provider: "bright_data",
      config: { freshness: "all", num_sources: 8, extraction: "clean" },
      model: "gpt-4o-mini",
      answer: "a",
      sources: [],
      latency_ms: 10,
      retrieval_score: 8,
      retrieval_rationale: "",
      score: 7,
      rationale: "",
    },
  ],
};

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("persist", () => {
  it("toRecord shapes a Run into a stable record", () => {
    const rec = toRecord(RUN, "run_x", "2026-07-23T00:00:00.000Z");
    expect(rec).toEqual({
      id: "run_x",
      ts: "2026-07-23T00:00:00.000Z",
      mode: "run",
      query: "q",
      variable: "provider",
      winner: "A",
      arms: RUN.arms,
    });
  });

  it("appends across processes: readRuns sees every appended line", () => {
    const dir = mkdtempSync(join(tmpdir(), "sourcery-"));
    tmpDirs.push(dir);
    const path = join(dir, "runs.jsonl");

    appendRun(toRecord(RUN, "run_1", "2026-07-23T00:00:00.000Z"), path);
    appendRun(toRecord(RUN, "run_2", "2026-07-23T00:01:00.000Z"), path);

    const runs = readRuns(path);
    expect(runs.map((r) => r.id)).toEqual(["run_1", "run_2"]);
    expect(runs[0].arms[0].retrieval_score).toBe(8);
  });

  it("readRuns returns [] when the file is absent", () => {
    expect(readRuns(join(tmpdir(), "does-not-exist-xyz.jsonl"))).toEqual([]);
  });
});
