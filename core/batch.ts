import { EVAL_DATASET, EvalQuery, QueryType } from "./eval-dataset";
import { runArm } from "./orchestrator";
import { DEFAULT_CONFIG, Provider, ProgressEvent, Source } from "./types";
import { defaultProviders } from "./adapters";
import { MODEL } from "./controls";
import { mapWithConcurrency } from "./extract";

// Offline batch eval: run every dataset query through a set of providers
// (provider axis, default config), then aggregate into (a) the heatmap and (b)
// raw per-query rows. Slow + credit-heavy, so it runs from the CLI (`sourcery
// batch`) and lands in .sourcery/runs.jsonl; `sourcery report` re-derives the
// heatmap from those persisted rows rather than re-running anything.
//
// The provider set is a parameter, not a constant. It used to be hardcoded to
// bright_data + firecrawl, which meant the other three registered adapters could
// never appear in a heatmap however many keys you held.

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
  // avg retrieval score per provider. A map, not two named fields: while this
  // was `{ bright_data, firecrawl }` no third provider could be plotted, which
  // meant tavily/exa were structurally excluded from every heatmap and from the
  // routing table derived off it — a shape decision quietly deciding which
  // providers the tool was allowed to have an opinion about.
  scores: Record<string, number>;
  runs: number; // runs per cell (max across providers)
}

export interface BatchOutput {
  generated_at: string;
  runs_per_cell: number;
  /** Provider ids plotted, in column order — the heatmap's x-axis. */
  providers: string[];
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
 *  skipping errored arms so a single failure doesn't tank a cell. Pure, so
 *  `report` can re-derive the grid from persisted rows without re-running. */
/** Provider ids present in `rows`, in first-seen order — the heatmap's columns. */
export function providersIn(rows: BatchRow[]): string[] {
  const seen: string[] = [];
  for (const r of rows) if (!seen.includes(r.provider)) seen.push(r.provider);
  return seen;
}

export function deriveHeatmap(rows: BatchRow[], providers = providersIn(rows)): HeatRow[] {
  const present = new Set(rows.map((r) => r.type));
  return TYPE_ORDER.filter((t) => present.has(t)).map((type) => {
    const ok = rows.filter((r) => r.type === type && !r.error);
    const scores: Record<string, number> = {};
    let runs = 0;
    for (const p of providers) {
      const xs = ok.filter((r) => r.provider === p).map((r) => r.retrieval_score);
      scores[p] = Number(avg(xs).toFixed(2));
      runs = Math.max(runs, xs.length);
    }
    return { type, label: TYPE_LABELS[type], scores, runs };
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
  opts: {
    model?: string;
    judgeModel?: string;
    providers?: string[];
    onProgress?: (event: ProgressEvent) => void;
  } = {},
): Promise<BatchOutput> {
  const model = opts.model?.trim() || MODEL;
  const judgeModel = opts.judgeModel?.trim() || MODEL;
  const providers = opts.providers?.length ? opts.providers : defaultProviders();

  // Flatten to (query × provider) arms, then run bounded-concurrent.
  const jobs = queries.flatMap((q) =>
    providers.map((provider) => ({ q, provider })),
  );

  // A full batch is 48 queries × every provider and takes minutes to an hour.
  // Without this it is indistinguishable from a hang, which is exactly how a
  // long run got abandoned before.
  let settled = 0;
  const rows = await mapWithConcurrency(jobs, BATCH_CONCURRENCY, async ({ q, provider }) => {
    const arm = await runArm(
      { id: provider, provider, config: { ...DEFAULT_CONFIG } },
      q.query,
      model,
      judgeModel,
    );
    opts.onProgress?.({ done: ++settled, total: jobs.length, label: `${provider} · ${q.query}` });
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

  // Pass `providers` explicitly rather than deriving from rows: a provider whose
  // every arm failed still deserves a column of zeros, not silent omission.
  const heatmap = deriveHeatmap(rows, providers);

  return {
    generated_at: new Date(now).toISOString(),
    runs_per_cell: runsPerCell(heatmap),
    providers,
    heatmap,
    rows,
  };
}
