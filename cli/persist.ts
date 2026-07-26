import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CredibilityRow, CredibilitySummary } from "@core/credibility";

// The runs.jsonl contract moved to @core/records so the dashboard's API routes
// can share it; re-exported here because it is still the CLI's write path and
// every command imports it from "../persist".
export { RUNS_PATH, toRunRecord, toBatchRecords, appendRecords, readRecords } from "@core/records";
export type { RunRecord, BatchRowRecord, SourceryRecord } from "@core/records";

// S2 credibility run writes to its own files, separate from the live-run
// contract above: raw per-arm rows (append-only) + a computed summary snapshot.
export const S2_RUNS_PATH = ".sourcery/s2-runs.jsonl";
export const S2_SUMMARY_PATH = ".sourcery/s2-summary.json";

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
