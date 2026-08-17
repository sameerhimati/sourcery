import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CredibilityRow, CredibilitySummary } from "@core/credibility";
import type {
  PooledFetchRow,
  PooledJudgementRow,
  PooledSetVerdictRow,
  PooledSummary,
} from "@core/pooled";
import type { NoSearchRow, NoSearchSummary } from "@core/noSearch";

// The runs.jsonl contract lives in @core/records so every door onto the engine
// shares one write path; re-exported here because this is still the CLI's, and
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

// Run 2 (the pooled run) writes to its own files again — fetches and judgements
// are different record shapes with different resume keys, and mixing them into
// one log is how a summary ends up computed over the wrong rows.
export const POOLED_FETCHES_PATH = ".sourcery/pooled-fetches.jsonl";
export const POOLED_JUDGEMENTS_PATH = ".sourcery/pooled-judgements.jsonl";
export const POOLED_SUMMARY_PATH = ".sourcery/pooled-summary.json";
/** Whole-set verdicts get their own log for the same reason: a set verdict is
 *  keyed by (query, provider, judge) while a pair verdict is keyed by
 *  (query, url, judge), and one log holding both resumes wrongly. */
export const POOLED_SET_VERDICTS_PATH = ".sourcery/pooled-set-verdicts.jsonl";
/** The no-search baseline is a property of the QUESTIONS, not of any provider,
 *  so it keeps its own file — it is valid across runs that share a question set
 *  and would be misread sitting next to per-provider rows. */
export const NO_SEARCH_PATH = ".sourcery/no-search.jsonl";
export const NO_SEARCH_SUMMARY_PATH = ".sourcery/no-search-summary.json";

function appendLine(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(value) + "\n");
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function appendPooledFetch(row: PooledFetchRow, path = POOLED_FETCHES_PATH): void {
  appendLine(path, row);
}

export function readPooledFetches(path = POOLED_FETCHES_PATH): PooledFetchRow[] {
  return readLines<PooledFetchRow>(path);
}

export function appendPooledJudgement(
  row: PooledJudgementRow,
  path = POOLED_JUDGEMENTS_PATH,
): void {
  appendLine(path, row);
}

export function readPooledJudgements(
  path = POOLED_JUDGEMENTS_PATH,
): PooledJudgementRow[] {
  return readLines<PooledJudgementRow>(path);
}

export function appendPooledSetVerdict(
  row: PooledSetVerdictRow,
  path = POOLED_SET_VERDICTS_PATH,
): void {
  appendLine(path, row);
}

export function readPooledSetVerdicts(
  path = POOLED_SET_VERDICTS_PATH,
): PooledSetVerdictRow[] {
  return readLines<PooledSetVerdictRow>(path);
}

export function appendNoSearchRow(row: NoSearchRow, path = NO_SEARCH_PATH): void {
  appendLine(path, row);
}

export function readNoSearchRows(path = NO_SEARCH_PATH): NoSearchRow[] {
  return readLines<NoSearchRow>(path);
}

export function writeNoSearchSummary(
  summary: NoSearchSummary,
  path = NO_SEARCH_SUMMARY_PATH,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
}

export function writePooledSummary(summary: PooledSummary, path = POOLED_SUMMARY_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
}
