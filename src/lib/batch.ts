import { EVAL_DATASET, EvalQuery, QueryType } from "./eval-dataset";
import { runArm } from "./orchestrator";
import { DEFAULT_CONFIG, Provider, Source } from "./types";
import { mapWithConcurrency } from "./extract";

// Offline batch eval: run every dataset query through BOTH providers (provider
// axis, default config), then aggregate into (a) the Scorecard heatmap and (b)
// raw per-query rows. Slow + credit-heavy, so results are committed to JSON and
// the Scorecard reads those for instant render; /api/batch regenerates on demand.

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
): Promise<BatchOutput> {
  // Flatten to (query × provider) arms, then run bounded-concurrent.
  const jobs = queries.flatMap((q) =>
    PROVIDERS.map((provider) => ({ q, provider })),
  );

  const rows = await mapWithConcurrency(jobs, BATCH_CONCURRENCY, async ({ q, provider }) => {
    const arm = await runArm(
      { id: provider, provider, config: { ...DEFAULT_CONFIG } },
      q.query,
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

  // Aggregate → heatmap. Average retrieval_score per (type, provider), skipping
  // errored arms so a single failure doesn't tank a cell.
  const present = new Set(rows.map((r) => r.type));
  const heatmap: HeatRow[] = TYPE_ORDER.filter((t) => present.has(t)).map((type) => {
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

  const runsPerCell = heatmap.length
    ? Math.round(avg(heatmap.map((h) => h.runs)))
    : 0;

  return {
    generated_at: new Date(now).toISOString(),
    runs_per_cell: runsPerCell,
    heatmap,
    rows,
  };
}
