import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Run } from "@core/types";
import type { BatchOutput, BatchRow } from "@core/batch";
import type { CredibilityRow, CredibilitySummary } from "@core/credibility";

// The JSONL file is THE contract — the terminal scorecard and HTML report are
// just views over it. One line per record, append-only, local files only.
export const RUNS_PATH = ".sourcery/runs.jsonl";

// S2 credibility run writes to its own files, separate from the live-run
// contract above: raw per-arm rows (append-only) + a computed summary snapshot.
export const S2_RUNS_PATH = ".sourcery/s2-runs.jsonl";
export const S2_SUMMARY_PATH = ".sourcery/s2-summary.json";

/** A single-query run (from `sourcery run`). */
export interface RunRecord {
  mode: "run";
  id: string;
  ts: string; // ISO timestamp
  query: string;
  variable: Run["variable"];
  winner: Run["winner"];
  judge_model: Run["judge_model"];
  arms: Run["arms"]; // full per-arm detail incl. retrieval / answer scores + sources
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
    judge_model: run.judge_model,
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

/** Append one finished arm. Called per-row while the run is still going, so a
 *  killed process loses at most the in-flight arms, not the whole matrix. */
export function appendCredibilityRow(
  row: CredibilityRow,
  runsPath = S2_RUNS_PATH,
): void {
  const dir = dirname(runsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(runsPath, JSON.stringify(row) + "\n");
}

/** Read back whatever arms already landed (for --resume + final summarize). */
export function readCredibilityRows(runsPath = S2_RUNS_PATH): CredibilityRow[] {
  if (!existsSync(runsPath)) return [];
  return readFileSync(runsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CredibilityRow);
}

export function writeCredibilitySummary(
  summary: CredibilitySummary,
  summaryPath = S2_SUMMARY_PATH,
): void {
  const dir = dirname(summaryPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
}

export function readRecords(path = RUNS_PATH): SourceryRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SourceryRecord);
}
