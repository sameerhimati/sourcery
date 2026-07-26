import { EVAL_DATASET, EvalQuery, QueryType } from "./eval-dataset";
import { runArm } from "./orchestrator";
import { DEFAULT_CONFIG, Provider, Source } from "./types";
import { MODEL } from "./controls";
import { mapWithConcurrency } from "./extract";

// Offline batch eval: run every dataset query through BOTH providers (provider
// axis, default config), then aggregate into (a) the Scorecard heatmap and (b)
// raw per-query rows. Slow + credit-heavy, so it runs from the CLI (`sourcery
// batch`) and lands in .sourcery/runs.jsonl; the dashboard re-derives the
// heatmap from those persisted rows rather than re-running anything.

const PROVIDERS: Provider[] = ["bright_data", "firecrawl"];
const BATCH_CONCURRENCY = 4; // arms in flight across the whole batch

// Human labels for the heatmap rows (design uses prose, not snake_case keys).
export const TYPE_LABELS: Record<QueryType, string> = {
  breaking_news: "breaking news",
  how_to: "how-to / explainer",
  product_lookup: "product lookup",
  local_geo: "local / geo",
  recent_release: "recent release",
  numeric_live: "numeric / live",
};

const TYPE_ORDER: QueryType[] = [
  "breaking_news",
  "how_to",
  "product_lookup",
  "local_geo",
  "recent_release",
  "numeric_live",
];

export interface BatchRow {
  queryId: string;
  type: QueryType;
  query: string;
  provider: Provider;
  retrieval_score: number;
  answer_score: number;
  retrieval_rationale: string;
  median_source_age_days: number | null;
  num_sources: number;
  num_sources_extracted: number;
  latency_ms: number;
  error?: string;
}

export interface HeatRow {
  type: QueryType;
  label: string;
  bright_data: number; // avg retrieval score
  firecrawl: number;
  runs: number; // runs per cell
}

export interface BatchOutput {
  generated_at: string;
  runs_per_cell: number;
  heatmap: HeatRow[];
  rows: BatchRow[];
}

function medianAgeDays(sources: Source[], now: number): number | null {
  const ages = sources
    .filter((s) => s.published)
    .map((s) => Math.round((now - new Date(s.published as string).getTime()) / 86400000))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  if (!ages.length) return null;
  const m = Math.floor(ages.length / 2);
  return ages.length % 2 ? ages[m] : Math.round((ages[m - 1] + ages[m]) / 2);
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : 0;
}

/** Aggregate rows → heatmap. Average retrieval_score per (type, provider),
 *  skipping errored arms so a single failure doesn't tank a cell. Pure, so the
 *  dashboard can re-derive the grid from persisted rows without re-running. */
export function deriveHeatmap(rows: BatchRow[]): HeatRow[] {
  const present = new Set(rows.map((r) => r.type));
  return TYPE_ORDER.filter((t) => present.has(t)).map((type) => {
    const ok = rows.filter((r) => r.type === type && !r.error);
    const bd = ok.filter((r) => r.provider === "bright_data").map((r) => r.retrieval_score);
    const fc = ok.filter((r) => r.provider === "firecrawl").map((r) => r.retrieval_score);
    return {
      type,
      label: TYPE_LABELS[type],
      bright_data: Number(avg(bd).toFixed(2)),
      firecrawl: Number(avg(fc).toFixed(2)),
      runs: Math.max(bd.length, fc.length),
    };
  });
}

/** Runs behind each heatmap cell, rounded — the "N runs per cell" caption. */
export function runsPerCell(heatmap: HeatRow[]): number {
  return heatmap.length ? Math.round(avg(heatmap.map((h) => h.runs))) : 0;
}

/** Pick a subset: up to `perType` queries from each type (0 = all). */
export function selectQueries(perType = 0): EvalQuery[] {
  if (!perType) return EVAL_DATASET;
  const byType = new Map<QueryType, number>();
  return EVAL_DATASET.filter((q) => {
    const n = byType.get(q.type) ?? 0;
    if (n >= perType) return false;
    byType.set(q.type, n + 1);
    return true;
  });
}

export async function runBatch(
  queries: EvalQuery[] = EVAL_DATASET,
  now: number = Date.now(),
  opts: { model?: string; judgeModel?: string } = {},
): Promise<BatchOutput> {
  const model = opts.model?.trim() || MODEL;
  const judgeModel = opts.judgeModel?.trim() || MODEL;

  // Flatten to (query × provider) arms, then run bounded-concurrent.
  const jobs = queries.flatMap((q) =>
    PROVIDERS.map((provider) => ({ q, provider })),
  );

  const rows = await mapWithConcurrency(jobs, BATCH_CONCURRENCY, async ({ q, provider }) => {
    const arm = await runArm(
      { id: provider, provider, config: { ...DEFAULT_CONFIG } },
      q.query,
      model,
      judgeModel,
    );
    const row: BatchRow = {
      queryId: q.id,
      type: q.type,
      query: q.query,
      provider,
      retrieval_score: arm.retrieval_score,
      answer_score: arm.score,
      retrieval_rationale: arm.retrieval_rationale,
      median_source_age_days: medianAgeDays(arm.sources, now),
      num_sources: arm.sources.length,
      num_sources_extracted: arm.sources.filter((s) => s.content).length,
      latency_ms: arm.latency_ms,
      ...(arm.error ? { error: arm.error } : {}),
    };
    return row;
  });

  const heatmap = deriveHeatmap(rows);

  return {
    generated_at: new Date(now).toISOString(),
    runs_per_cell: runsPerCell(heatmap),
    heatmap,
    rows,
  };
}
