import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Run } from "@core/types";

// The JSONL file is THE contract — the terminal scorecard and HTML report are
// just views over it. One line per run, append-only, local files only.
export const RUNS_PATH = ".sourcery/runs.jsonl";

export interface RunRecord {
  id: string;
  ts: string; // ISO timestamp
  mode: "run";
  query: string;
  variable: Run["variable"];
  winner: Run["winner"];
  arms: Run["arms"]; // full per-arm detail incl. retrieval_score / answer score
}

/** Pure: shape a Run + identity into a persistable record (testable without I/O). */
export function toRecord(run: Run, id: string, ts: string): RunRecord {
  return {
    id,
    ts,
    mode: "run",
    query: run.query,
    variable: run.variable,
    winner: run.winner,
    arms: run.arms,
  };
}

export function appendRun(record: RunRecord, path = RUNS_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

export function readRuns(path = RUNS_PATH): RunRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord);
}
