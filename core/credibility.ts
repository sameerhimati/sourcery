// ─── S2: the credibility run ───
// The README's headline eval was underpowered (single run, one judge, no CIs, no
// inter-judge agreement). This runner produces the stronger data: every query,
// both providers, N seeds (fresh fetch each), graded by a PANEL of judge models.
//
// Two axes of noise are measured separately, because they mean different things:
//   • seed noise  — re-fetch + re-answer variance. SERP is near-deterministic, so
//     this is expected to be ~0 for retrieval_score; it shows up in answer_score.
//   • judge noise — disagreement BETWEEN judge models on the same sources/answer.
//     This is where retrieval_score's real uncertainty lives.
// The statistical unit for confidence intervals is the QUERY (the population we
// sample), with seed+judge noise folded into each query's mean.
//
// Leaves the live Arm/Run/batch contracts untouched — this is a separate path.

import { EVAL_DATASET, EvalQuery, QueryType } from "./eval-dataset";
import { fetchSources, DEFAULT_PROVIDERS } from "./adapters";
import { answer } from "./answer";
import { judge } from "./judge";
import { retrievalJudge } from "./retrievalJudge";
import { DEFAULT_CONFIG, Provider, Source } from "./types";
import { mapWithConcurrency } from "./extract";

const DEFAULT_CONCURRENCY = 4; // (query×provider×seed) pipelines in flight; retrieval-bound

/** One judge model's verdict on a single arm (both scores it produced). */
export interface Judgement {
  judge: string; // short label, e.g. "glm-5p2"
  retrieval_score: number;
  retrieval_rationale: string;
  answer_score: number;
  answer_rationale: string;
}

/** One (query × provider × seed) pipeline: fetched once, graded by every judge. */
export interface CredibilityRow {
  queryId: string;
  type: QueryType;
  query: string;
  provider: Provider;
  seed: number;
  num_sources: number;
  num_sources_extracted: number;
  median_source_age_days: number | null;
  domains: string[];
  latency_ms: number;
  judgements: Judgement[];
  error?: string;
  // median_source_age_days above is only meaningful relative to WHEN the sources
  // were fetched. Recorded so a re-judge over cached fetches can't pass off
  // yesterday's ages as today's. Optional: pre-cache rows are still valid.
  fetched_at?: string;
  from_cache?: boolean;
}

// ─── stats helpers (pure) ───

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Sample standard deviation (n-1). 0 for n<2. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// Two-sided t critical values at 95% for small df; ≥30 ≈ normal (1.96).
const T95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 15: 2.131, 20: 2.086, 25: 2.06, 30: 2.042,
};
function tCrit(df: number): number {
  if (df <= 0) return 0;
  if (T95[df]) return T95[df];
  const keys = Object.keys(T95).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df <= k) return T95[k];
  return 1.96;
}

/** 95% CI half-width for a sample mean (t-based). n<2 → 0. */
export function ci95(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  return tCrit(n - 1) * (stddev(xs) / Math.sqrt(n));
}

/** Pearson correlation. 0 if either side is constant or n<2. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** Short, human label for a model ref: the last path segment. */
export function judgeLabel(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] || ref;
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

// ─── the runner ───

export interface CredibilityOpts {
  seeds?: number; // default 5
  model?: string; // answer model, held constant
  judges: string[]; // panel of judge model refs (≥1)
  concurrency?: number; // pipelines in flight; default DEFAULT_CONCURRENCY
  now?: number;
  /** Called as each pipeline lands. The caller persists here — a 2h run must
   *  survive being killed, so rows hit disk immediately, not at the end. */
  onRow?: (row: CredibilityRow, done: number, total: number) => void;
  /** Skip pipelines already on disk (resume). Keyed by armKey(). */
  done?: ReadonlySet<string>;
  /** Bail out if a provider's first N arms ALL fail. 0 disables. Default 8. */
  failFast?: number;
  /** Which arms to compare. Default: the registry's default pair. */
  providers?: Provider[];
}

/** Thrown when a provider is systematically broken (bad key, no credits, outage). */
export class ProviderDeadError extends Error {
  constructor(readonly provider: Provider, readonly sample: string) {
    super(
      `Provider "${provider}" failed its first arms — aborting before this burns ` +
        `hours and credits on a dead matrix. Last error: ${sample}\n` +
        `Fix it, then re-run with --resume to keep the arms already on disk.`,
    );
    this.name = "ProviderDeadError";
  }
}

/** Identity of one pipeline — the resume/dedup key. */
export function armKey(queryId: string, provider: Provider, seed: number): string {
  return `${queryId}|${provider}|${seed}`;
}

/**
 * Run the full credibility matrix: queries × providers × seeds, each fetched
 * fresh and graded by every judge in the panel. Never throws per-arm — a failed
 * pipeline becomes a row with `error` set and no judgements.
 */
export async function runCredibility(
  queries: EvalQuery[] = EVAL_DATASET,
  opts: CredibilityOpts = { judges: [] },
): Promise<CredibilityRow[]> {
  const seeds = opts.seeds ?? 5;
  const model = opts.model?.trim() || undefined;
  const now = opts.now ?? Date.now();
  const judges = opts.judges;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const providers = opts.providers?.length ? opts.providers : DEFAULT_PROVIDERS;

  // Flatten to independent pipelines. Seed is just a repeat index — the variance
  // comes from a fresh fetch + a temp>0 answer, not from a threaded RNG seed.
  const jobs = queries
    .flatMap((q) =>
      providers.flatMap((provider) =>
        Array.from({ length: seeds }, (_, seed) => ({ q, provider, seed })),
      ),
    )
    .filter(({ q, provider, seed }) => !opts.done?.has(armKey(q.id, provider, seed)));

  const total = jobs.length;
  let landed = 0;

  // A provider with a revoked key or an empty credit balance fails every arm
  // identically. Without this, a 480-arm run cheerfully grinds for two hours
  // producing nothing but 402s (learned the hard way).
  const failFast = opts.failFast ?? 8;
  const tally = new Map<Provider, { ok: number; fail: number; last: string }>();
  const record = (row: CredibilityRow): void => {
    const t = tally.get(row.provider) ?? { ok: 0, fail: 0, last: "" };
    if (row.error) {
      t.fail++;
      t.last = row.error;
    } else {
      t.ok++;
    }
    tally.set(row.provider, t);
    if (failFast > 0 && t.ok === 0 && t.fail >= failFast) {
      throw new ProviderDeadError(row.provider, t.last.slice(0, 200));
    }
  };

  return mapWithConcurrency(jobs, concurrency, async ({ q, provider, seed }) => {
    const start = Date.now();
    const rowBase = {
      queryId: q.id,
      type: q.type,
      query: q.query,
      provider,
      seed,
    };
    // Persist first, then check — a row that triggers the abort is still saved.
    const emit = (row: CredibilityRow): CredibilityRow => {
      opts.onRow?.(row, ++landed, total);
      record(row);
      return row;
    };
    try {
      // `seed` is passed to the cache so each repeat keeps its own entry. Sharing
      // one across seeds would zero out seed_std_mean — the exact number this
      // matrix exists to measure.
      const { sources, context, fetched_at, from_cache } = await fetchSources(
        provider,
        q.query,
        { ...DEFAULT_CONFIG },
        seed,
      );
      const ans = await answer(q.query, context, model);
      // Every judge grades the SAME sources + answer for this seed, in parallel.
      const judgements = await Promise.all(
        judges.map(async (j): Promise<Judgement> => {
          const [r, a] = await Promise.all([
            retrievalJudge(q.query, sources, j),
            judge(q.query, ans, sources, j),
          ]);
          return {
            judge: judgeLabel(j),
            retrieval_score: r.score,
            retrieval_rationale: r.rationale,
            answer_score: a.score,
            answer_rationale: a.rationale,
          };
        }),
      );
      const row: CredibilityRow = {
        ...rowBase,
        num_sources: sources.length,
        num_sources_extracted: sources.filter((s) => s.content).length,
        median_source_age_days: medianAgeDays(sources, now),
        domains: sources.map((s) => s.domain),
        latency_ms: Date.now() - start,
        fetched_at,
        from_cache,
        judgements,
      };
      return emit(row);
    } catch (e) {
      return emit({
        ...rowBase,
        num_sources: 0,
        num_sources_extracted: 0,
        median_source_age_days: null,
        domains: [],
        latency_ms: Date.now() - start,
        judgements: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

// ─── aggregation → the numbers the README will quote ───

export interface ProviderStat {
  provider: Provider;
  n_queries: number; // independent statistical units
  retrieval_mean: number;
  retrieval_ci95: number; // half-width; report as mean ± ci
  answer_mean: number;
  answer_ci95: number;
  // Reliability, kept beside quality because the scores above are computed from
  // surviving arms only — a provider that fails half its queries and scores well
  // on the rest looks identical to one that never fails, unless you report this.
  n_arms: number; // arms attempted, failures included
  n_errors: number;
  error_rate: number; // n_errors / n_arms
}

export interface TypeStat extends ProviderStat {
  type: QueryType;
}

export interface AgreementStat {
  metric: "retrieval" | "answer";
  judge_a: string;
  judge_b: string;
  pearson: number;
  mean_abs_diff: number;
  within_1_rate: number; // fraction of arms where |a-b| ≤ 1
  n: number;
}

export interface VarianceDecomp {
  // Both on the retrieval_score, the primary metric.
  seed_std_mean: number; // avg (over query×provider×judge) of std across seeds
  judge_gap_mean: number; // avg (over query×provider×seed) of |judgeA - judgeB|
}

export interface CredibilitySummary {
  generated_at: string;
  seeds: number;
  answer_model: string;
  judges: string[];
  n_rows: number;
  n_errors: number;
  providers: Provider[]; // arms actually compared (not assumed)
  n_queries: number; // distinct queries actually attempted
  // A judge that returns prose instead of JSON scores 0 — indistinguishable
  // from a genuine 0 once it's a number, and it drags every mean down with it.
  // Counted here so a corrupted headline number can't stay invisible.
  n_unparseable_judgements: number;
  by_provider: ProviderStat[];
  by_type: TypeStat[];
  agreement: AgreementStat[];
  variance: VarianceDecomp;
}

/** Every (retrieval, answer) score a row produced, flattened across judges. */
function rowScores(row: CredibilityRow): { retrieval: number[]; answer: number[] } {
  return {
    retrieval: row.judgements.map((j) => j.retrieval_score),
    answer: row.judgements.map((j) => j.answer_score),
  };
}

/** Collapse a query's seeds+judges into one mean per metric (the CI unit). */
function queryMeans(rows: CredibilityRow[]): { retrieval: number; answer: number } {
  const r: number[] = [], a: number[] = [];
  for (const row of rows) {
    const s = rowScores(row);
    r.push(...s.retrieval);
    a.push(...s.answer);
  }
  return { retrieval: mean(r), answer: mean(a) };
}

function providerStat(rows: CredibilityRow[], provider: Provider): ProviderStat {
  // One value per query (folds seed+judge noise in), then CI over queries.
  const byQuery = new Map<string, CredibilityRow[]>();
  for (const row of rows) {
    if (row.provider !== provider || row.error) continue;
    (byQuery.get(row.queryId) ?? byQuery.set(row.queryId, []).get(row.queryId)!).push(row);
  }
  const retMeans: number[] = [], ansMeans: number[] = [];
  for (const qrows of byQuery.values()) {
    const m = queryMeans(qrows);
    retMeans.push(m.retrieval);
    ansMeans.push(m.answer);
  }
  // Counted over every attempted arm, not the surviving ones above: the whole
  // point is to catch the provider whose good scores come from a small sample
  // of the queries it was actually asked.
  const attempted = rows.filter((r) => r.provider === provider);
  const errors = attempted.filter((r) => r.error).length;

  return {
    provider,
    n_queries: byQuery.size,
    retrieval_mean: Number(mean(retMeans).toFixed(2)),
    retrieval_ci95: Number(ci95(retMeans).toFixed(2)),
    answer_mean: Number(mean(ansMeans).toFixed(2)),
    answer_ci95: Number(ci95(ansMeans).toFixed(2)),
    n_arms: attempted.length,
    n_errors: errors,
    error_rate: attempted.length ? Number((errors / attempted.length).toFixed(4)) : 0,
  };
}

/** Which arms this row set actually covers — derived, so a resumed run that
 *  mixes provider sets still summarizes everything it has. */
function providersIn(rows: CredibilityRow[]): Provider[] {
  return [...new Set(rows.map((r) => r.provider))];
}

function typeStats(rows: CredibilityRow[], providers: Provider[]): TypeStat[] {
  const types = [...new Set(rows.map((r) => r.type))];
  const out: TypeStat[] = [];
  for (const type of types) {
    for (const provider of providers) {
      const sub = rows.filter((r) => r.type === type);
      const ps = providerStat(sub, provider);
      out.push({ ...ps, type });
    }
  }
  return out;
}

/** Pair up two judges' scores across every arm they both graded. */
function agreementFor(
  rows: CredibilityRow[],
  metric: "retrieval" | "answer",
  ja: string,
  jb: string,
): AgreementStat {
  const a: number[] = [], b: number[] = [];
  const key = metric === "retrieval" ? "retrieval_score" : "answer_score";
  for (const row of rows) {
    if (row.error) continue;
    const va = row.judgements.find((j) => j.judge === ja);
    const vb = row.judgements.find((j) => j.judge === jb);
    if (!va || !vb) continue;
    a.push(va[key]);
    b.push(vb[key]);
  }
  const diffs = a.map((x, i) => Math.abs(x - b[i]));
  return {
    metric,
    judge_a: ja,
    judge_b: jb,
    pearson: Number(pearson(a, b).toFixed(3)),
    mean_abs_diff: Number(mean(diffs).toFixed(2)),
    within_1_rate: Number((diffs.filter((d) => d <= 1).length / (diffs.length || 1)).toFixed(3)),
    n: a.length,
  };
}

function varianceDecomp(rows: CredibilityRow[], judgeLabels: string[]): VarianceDecomp {
  // seed noise: std of retrieval_score across seeds, per (query,provider,judge).
  const seedGroups = new Map<string, number[]>();
  // judge gap: |judgeA - judgeB| on retrieval, per (query,provider,seed).
  const judgeGaps: number[] = [];
  const [ja, jb] = judgeLabels;
  for (const row of rows) {
    if (row.error) continue;
    for (const j of row.judgements) {
      const k = `${row.queryId}|${row.provider}|${j.judge}`;
      (seedGroups.get(k) ?? seedGroups.set(k, []).get(k)!).push(j.retrieval_score);
    }
    if (ja && jb) {
      const va = row.judgements.find((j) => j.judge === ja)?.retrieval_score;
      const vb = row.judgements.find((j) => j.judge === jb)?.retrieval_score;
      if (va !== undefined && vb !== undefined) judgeGaps.push(Math.abs(va - vb));
    }
  }
  const seedStds = [...seedGroups.values()].map((xs) => stddev(xs));
  return {
    seed_std_mean: Number(mean(seedStds).toFixed(3)),
    judge_gap_mean: Number(mean(judgeGaps).toFixed(3)),
  };
}

export function summarize(
  rows: CredibilityRow[],
  meta: { seeds: number; answer_model: string; judges: string[]; now: number },
): CredibilitySummary {
  const labels = meta.judges.map(judgeLabel);
  const providers = providersIn(rows);
  // All unordered judge pairs (usually just one for a 2-judge panel).
  const pairs: [string, string][] = [];
  for (let i = 0; i < labels.length; i++)
    for (let k = i + 1; k < labels.length; k++) pairs.push([labels[i], labels[k]]);

  const agreement: AgreementStat[] = [];
  for (const [ja, jb] of pairs) {
    agreement.push(agreementFor(rows, "retrieval", ja, jb));
    agreement.push(agreementFor(rows, "answer", ja, jb));
  }

  return {
    generated_at: new Date(meta.now).toISOString(),
    seeds: meta.seeds,
    answer_model: meta.answer_model,
    judges: meta.judges,
    n_rows: rows.length,
    n_errors: rows.filter((r) => r.error).length,
    providers,
    n_queries: new Set(rows.map((r) => r.queryId)).size,
    n_unparseable_judgements: rows.reduce(
      (n, r) =>
        n +
        r.judgements.filter(
          (j) =>
            j.retrieval_rationale.includes("unparseable") ||
            j.answer_rationale.includes("unparseable"),
        ).length,
      0,
    ),
    by_provider: providers.map((p) => providerStat(rows, p)),
    by_type: typeStats(rows, providers),
    agreement,
    variance: varianceDecomp(rows, labels),
  };
}
