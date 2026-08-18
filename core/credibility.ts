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
import { fetchSources, defaultProviders } from "./adapters";
import { answer } from "./answer";
import { judge } from "./judge";
import { retrievalJudge } from "./retrievalJudge";
import { DEFAULT_CONFIG, ErrorStage, Provider, Source } from "./types";
import { stage, stageOf } from "./stage";
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
  // Which step threw. Absent on rows written before this existed — those fall
  // back to reading the error string, which is why the published table charged
  // an LLM timeout to a provider. See core/stage.ts.
  error_stage?: ErrorStage;
  // Provider fetch alone. latency_ms is the whole row (fetch + answer + judges),
  // so it can never be quoted as a provider's latency.
  fetch_ms?: number;
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

/**
 * Nearest-rank percentile (p in 0..1). null on an empty sample.
 *
 * Deliberately returns null rather than 0: a latency of 0ms is a claim, and the
 * absence of a measurement must not render as a fast provider. Every caller has
 * to decide what to print when there's nothing to print.
 */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
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
      `Provider "${provider}" failed its first results — aborting before this burns ` +
        `hours and credits on a dead matrix. Last error: ${sample}\n` +
        `Fix it, then re-run with --resume to keep the results already on disk.`,
    );
    this.name = "ProviderDeadError";
  }
}

/** Thrown when the network goes away mid-run, rather than at the start. */
export class NetworkDeadError extends Error {
  constructor(readonly consecutive: number, readonly sample: string) {
    super(
      `${consecutive} results in a row failed to reach the network — this machine ` +
        `lost its connection, so nothing after this point would measure a provider.\n` +
        `Stopped rather than racing to a false finish. Last error: ${sample}\n` +
        `Re-run with --resume when you're back online: everything already on disk ` +
        `is kept, and these attempts are retried.`,
    );
    this.name = "NetworkDeadError";
  }
}

export const NETWORK_DEAD_AFTER = 12;

/**
 * Trips when the machine loses its connection partway through a run.
 *
 * Counts CONSECUTIVE transport failures across every provider, because that is
 * the signature of a dead network: a genuinely broken provider still lets the
 * others through, so the counter resets the moment anything succeeds.
 *
 * `failFast` could not catch this — it only ever inspected a provider's FIRST
 * results. A connection that died 70 results into 480 was invisible to it, and
 * the run churned the remaining 412 in minutes before finishing by overwriting
 * the published summary with a matrix of nothing.
 */
export function createNetworkBreaker(limit = NETWORK_DEAD_AFTER) {
  let consecutive = 0;
  let last = "";
  return {
    /** True when this was a transport failure, so the caller stops counting it. */
    observe(error: string | undefined): boolean {
      if (!isTransportFailure(error)) {
        consecutive = 0;
        return false;
      }
      consecutive++;
      last = error ?? "";
      if (consecutive >= limit) throw new NetworkDeadError(consecutive, last.slice(0, 200));
      return true;
    },
  };
}

/** Identity of one pipeline — the resume/dedup key. */
export function armKey(queryId: string, provider: Provider, seed: number): string {
  return `${queryId}|${provider}|${seed}`;
}

/**
 * Did this result fail because YOUR machine lost the network, rather than
 * because the provider failed?
 *
 * The distinction decides what `--resume` is allowed to skip, and it matters
 * more here than anywhere else in the codebase: the headline reliability claim
 * IS the failure rate. A provider's 4xx, its non-JSON, its timeout — those are
 * data, and retrying them until they pass would manufacture a better number than
 * the product deserves. A DNS failure because the wifi dropped is not data, and
 * skipping it on resume bakes your outage into a published statistic and
 * attributes it to a vendor.
 *
 * Deliberately narrow: it matches the handful of Node/undici codes that can only
 * mean the local network went away. Anything ambiguous is treated as a real
 * provider failure, because over-counting your own outage is the safer error —
 * it makes a provider look worse than it is, which is at least visible, rather
 * than better than it is, which is not.
 */
const TRANSPORT_FAILURES =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETDOWN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|fetch failed|connection error|network is (down|unreachable)/i;

export function isTransportFailure(error: string | undefined): boolean {
  return Boolean(error && TRANSPORT_FAILURES.test(error));
}

/**
 * Did this result fail because YOUR account ran out, rather than because the
 * provider failed?
 *
 * The published run reported Firecrawl at 2 failures in 240. Both were
 * `402 Insufficient credits` — a plan running dry mid-run. Firecrawl returned
 * something on every call it was actually asked to serve, and the eval said
 * otherwise in a table comparing it to a competitor. An eval that can't tell
 * "the provider broke" from "you ran out of money" is measuring your wallet and
 * printing it as reliability.
 *
 * Counted and reported, never silently dropped: an account that died mid-run is
 * a fact about the run, and hiding it would make a truncated matrix look
 * complete. It just isn't the provider's fault.
 *
 * The status code is not enough on its own. Run 2 hit `Tavily 432: this request
 * exceeds your plan` — a plan running dry, worded as neither 402 nor "credits",
 * under a status code no other provider uses. It would have been published as
 * twelve Tavily failures and skipped by resume, so topping up would not have
 * gone back for them. Match the wording as well as the code, because every
 * provider invents its own way of saying the same thing.
 */
const ACCOUNT_FAILURES =
  /\b(401|402|403)\b|insufficient credit|quota exceeded|payment required|out of credits|billing|exceeds your (plan|usage)|plan limit|usage limit|credit limit/i;

export function isAccountFailure(error: string | undefined): boolean {
  return Boolean(error && !isTransportFailure(error) && ACCOUNT_FAILURES.test(error));
}

/**
 * A failure the provider is actually answerable for.
 *
 * `stage` is authoritative when present: an answer or judge call that died says
 * nothing about the retrieval under test, however its message reads. Rows
 * written before staging existed have no stage, and fall back to the string
 * predicates — which is exactly how "Request timed out." from the OpenAI SDK got
 * published as an Exa failure. Treat a stageless row as evidence about the
 * harness, not about the vendor.
 */
export function isProviderFailure(error: string | undefined, stage?: ErrorStage): boolean {
  if (!error) return false;
  if (stage && stage !== "provider") return false;
  return !isTransportFailure(error) && !isAccountFailure(error);
}

/**
 * The results `--resume` may skip: everything on disk except the ones that
 * failed because the network went away. Those get another attempt.
 */
export function resumableKeys(rows: CredibilityRow[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (isTransportFailure(r.error)) continue;
    keys.add(armKey(r.queryId, r.provider, r.seed));
  }
  return keys;
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
  const providers = opts.providers?.length ? opts.providers : defaultProviders();

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

  // failFast only ever looked at a provider's FIRST results, so a network that
  // died 70 results into a 480-result run was invisible to it: the run churned
  // through the remaining 412 in minutes, wrote 412 failures to the log, and
  // would have finished by overwriting the published summary with a matrix of
  // nothing. Learned by watching it happen.
  //
  // Counts CONSECUTIVE transport failures across all providers, because that is
  // the signature of a dead connection — a genuinely broken provider still lets
  // the others through, and this resets the moment anything succeeds.
  const breaker = createNetworkBreaker();

  const record = (row: CredibilityRow): void => {
    // Not the provider's fault, so it must not count toward failFast either.
    if (breaker.observe(row.error)) return;

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
    // Hoisted: a judge that dies must not erase what the provider returned, or
    // the row reads as "retrieved nothing" for a fetch that worked.
    let fetched: Awaited<ReturnType<typeof fetchSources>> | undefined;
    let fetch_ms: number | undefined;
    try {
      // `seed` is passed to the cache so each repeat keeps its own entry. Sharing
      // one across seeds would zero out seed_std_mean — the exact number this
      // matrix exists to measure.
      const fetchStart = Date.now();
      fetched = await stage(
        "provider",
        fetchSources(provider, q.query, { ...DEFAULT_CONFIG }, seed),
      );
      fetch_ms = Date.now() - fetchStart;
      const { sources, context, fetched_at, from_cache } = fetched;
      const ans = await stage("answer", answer(q.query, context, model));
      // Every judge grades the SAME sources + answer for this seed, in parallel.
      const judgements = await stage(
        "judge",
        Promise.all(
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
        ),
      );
      const row: CredibilityRow = {
        ...rowBase,
        num_sources: sources.length,
        num_sources_extracted: sources.filter((s) => s.content).length,
        median_source_age_days: medianAgeDays(sources, now),
        domains: sources.map((s) => s.domain),
        latency_ms: Date.now() - start,
        fetch_ms,
        fetched_at,
        from_cache,
        judgements,
      };
      return emit(row);
    } catch (e) {
      const sources = fetched?.sources ?? [];
      return emit({
        ...rowBase,
        num_sources: sources.length,
        num_sources_extracted: sources.filter((s) => s.content).length,
        median_source_age_days: medianAgeDays(sources, now),
        domains: sources.map((s) => s.domain),
        latency_ms: Date.now() - start,
        ...(fetch_ms !== undefined ? { fetch_ms } : {}),
        ...(fetched?.fetched_at ? { fetched_at: fetched.fetched_at } : {}),
        ...(fetched ? { from_cache: fetched.from_cache } : {}),
        judgements: [],
        error: e instanceof Error ? e.message : String(e),
        error_stage: stageOf(e),
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
  n_arms: number; // results attempted, failures included
  // Failures the PROVIDER is answerable for. A 402 from your own exhausted plan
  // is not one, and counting it as one told a competitor's story for them —
  // Firecrawl was reported at 2 failures in 240 when it had none.
  n_errors: number;
  error_rate: number; // n_errors / n_arms
  // Your account dying mid-run. Reported rather than dropped: it explains a
  // truncated matrix, it just isn't a reliability signal about the provider.
  n_account_errors: number;
  // Provider latency, over `fetch_ms` — the retrieval call ALONE. Never compute
  // this from `latency_ms`: that spans fetch + answer + the whole judge panel,
  // so it is mostly a measurement of my own LLM calls, and publishing it as a
  // provider's latency would attribute my model's slowness to their API.
  //
  // null when nothing in the sample carried a fetch_ms — rows written before it
  // existed don't have one, and a percentile over zero values must not render
  // as a fast provider. `n_fetch_timed` is what makes that checkable: a p50 over
  // 3 of 240 arms is not a latency claim, and the reader has to be able to see
  // that without opening the raw log.
  fetch_ms_p50: number | null;
  fetch_ms_p95: number | null;
  n_fetch_timed: number;
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
  const errors = attempted.filter((r) => isProviderFailure(r.error, r.error_stage)).length;
  const accountErrors = attempted.filter((r) => isAccountFailure(r.error)).length;

  // Timed fetches only, across every attempted arm — including arms whose answer
  // or judge later failed, because the provider still returned and that fetch is
  // a real measurement of it. A fetch that itself threw carries no fetch_ms, so
  // a failed retrieval never lands in the latency sample as a fast one.
  const fetchMs = attempted
    .map((r) => r.fetch_ms)
    .filter((ms): ms is number => typeof ms === "number");

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
    n_account_errors: accountErrors,
    fetch_ms_p50: percentile(fetchMs, 0.5),
    fetch_ms_p95: percentile(fetchMs, 0.95),
    n_fetch_timed: fetchMs.length,
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

/**
 * Collapse the raw log into one row per (query, provider, seed).
 *
 * The log is append-only, so a retried result leaves the old attempt behind it.
 * Counting both would inflate `n_arms` and, worse, keep counting a superseded
 * failure in the error rate — the number this whole run exists to measure. Last
 * write wins, because rows are appended in the order they completed.
 *
 * Transport failures that were never retried are dropped rather than counted:
 * they record that this machine lost its network, and attributing that to a
 * provider is exactly the mistake the retry logic exists to prevent.
 */
export function dedupeRows(rows: CredibilityRow[]): CredibilityRow[] {
  const latest = new Map<string, CredibilityRow>();
  for (const r of rows) latest.set(armKey(r.queryId, r.provider, r.seed), r);
  return [...latest.values()].filter((r) => !isTransportFailure(r.error));
}

export function summarize(
  raw: CredibilityRow[],
  meta: { seeds: number; answer_model: string; judges: string[]; now: number },
): CredibilitySummary {
  const rows = dedupeRows(raw);
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
