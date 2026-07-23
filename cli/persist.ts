import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Run } from "@core/types";
import type { BatchOutput, BatchRow } from "@core/batch";

// The JSONL file is THE contract — the terminal scorecard and HTML report are
// just views over it. One line per record, append-only, local files only.
export const RUNS_PATH = ".sourcery/runs.jsonl";

/** A single-query run (from `sourcery run`). */
export interface RunRecord {
  mode: "run";
  id: string;
  ts: string; // ISO timestamp
  query: string;
  variable: Run["variable"];
  winner: Run["winner"];
  arms: Run["arms"]; // full per-arm detail incl. retrieval / answer scores
}

/** One (query × provider) row of a batch (from `sourcery batch`). */
export interface BatchRowRecord {
  mode: "batch";
  batchId: string;
  ts: string; // ISO timestamp of the batch
  row: BatchRow;
}

export type SourceryRecord = RunRecord | BatchRowRecord;

/** Pure: shape a Run + identity into a persistable record (testable without I/O). */
export function toRunRecord(run: Run, id: string, ts: string): RunRecord {
  return {
    mode: "run",
    id,
    ts,
    query: run.query,
    variable: run.variable,
    winner: run.winner,
    arms: run.arms,
  };
}

/** Pure: explode a BatchOutput into one record per row under a shared batchId. */
export function toBatchRecords(
  out: BatchOutput,
  batchId: string,
): BatchRowRecord[] {
  return out.rows.map((row: BatchRow) => ({
    mode: "batch",
    batchId,
    ts: out.generated_at,
    row,
  }));
}

export function appendRecords(
  records: SourceryRecord[],
  path = RUNS_PATH,
): void {
  if (!records.length) return;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function readRecords(path = RUNS_PATH): SourceryRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SourceryRecord);
}
