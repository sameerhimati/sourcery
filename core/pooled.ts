// ─── Run 2: the pooled run ───
// The instrument committed to in docs/preregistration-v3.md, and argued for in
// docs/eval-harness.md. Three phases, each resumable:
//
//   1. fetch  — every (query × provider), once. The only step that costs money.
//   2. judge  — pool every returned page, then each unique question-and-page
//               pair is rated 0–3 by every judge on the panel, exactly once.
//               The judge never sees a provider name; pooling already detached
//               pages from whoever returned them.
//   3. score  — a provider's result on a query is computed from its returned
//               set against the pooled verdicts. A provider-fault failure is a
//               miss (it didn't return the pages); an our-fault failure
//               (network, billing) is excluded and published, never scored.
//
// Separate from run 1 (batch/credibility) on purpose: different instrument,
// different files, nothing here touches the paths the published run 1 numbers
// came from.

import type { EvalQuery, Genre, QueryType, Sharpness } from "./eval-dataset";
import { fetchSources } from "./adapters";
import { DEFAULT_CONFIG, ErrorStage, Provider, Source } from "./types";
import { stage, stageOf } from "./stage";
import { mapWithConcurrency } from "./extract";
import { buildPool, pairKey, PooledPage, returnedUrls } from "./pool";
import { parseRungVerdict, relevanceJudge, relevanceMessages } from "./relevanceJudge";
import { parseSetVerdict, setJudge, setJudgeMessages } from "./setJudge";
import { completeBatch } from "./llm/batch";
import { RELEVANCE_JUDGE_TEMP, RETRIEVAL_JUDGE_TEMP } from "./controls";
import {
  ci95,
  createNetworkBreaker,
  isAccountFailure,
  isProviderFailure,
  isTransportFailure,
  judgeLabel,
  mean,
  percentile,
  ProviderDeadError,
} from "./credibility";

const DEFAULT_CONCURRENCY = 4;

/** A rung of 2 or higher counts as relevant when the scale is collapsed to
 *  binary — the robustness check the analysis reports beside the graded mean. */
export const RELEVANT_AT = 2;

// ─── phase 1: fetch ───

export interface PooledFetchRow {
  queryId: string;
  type: QueryType;
  query: string;
  /** Carried onto the row, not just the query file, because nothing else in the
   *  run log records it — a slice by sharpness computed after the fact would
   *  otherwise need the query file to still exist, unedited, months later. */
  sharpness?: Sharpness;
  /** Carried for the same reason as sharpness: a slice by subject computed
   *  after the fact would need the query file to still exist, unedited. */
  genre?: Genre;
  provider: Provider;
  num_sources: number;
  num_extracted: number;
  /** The provider's returned set: normalized URLs, deduped, order kept. */
  urls: string[];
  /** Full sources, kept for pool building and for publishing the raw data. */
  sources: Source[];
  fetch_ms?: number;
  fetched_at?: string;
  from_cache?: boolean;
  error?: string;
  error_stage?: ErrorStage;
}

/** Identity of one fetch — the resume/dedup key. One fetch per pair: repeats
 *  measured seed noise in run 1 (SEED_NOISE); run 2 spends the budget on
 *  breadth instead. */
export function fetchKey(queryId: string, provider: Provider): string {
  return `${queryId}|${provider}`;
}

export interface PooledFetchOpts {
  concurrency?: number;
  onRow?: (row: PooledFetchRow, done: number, total: number) => void;
  /** Keys already on disk (resume). */
  done?: ReadonlySet<string>;
  /** Abort if a provider's first N fetches ALL fail. 0 disables. Default 8. */
  failFast?: number;
}

export async function runPooledFetch(
  queries: EvalQuery[],
  providers: Provider[],
  opts: PooledFetchOpts = {},
): Promise<PooledFetchRow[]> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const jobs = queries
    .flatMap((q) => providers.map((provider) => ({ q, provider })))
    .filter(({ q, provider }) => !opts.done?.has(fetchKey(q.id, provider)));
  const total = jobs.length;
  let landed = 0;

  const failFast = opts.failFast ?? 8;
  const tally = new Map<Provider, { ok: number; fail: number; last: string }>();
  const breaker = createNetworkBreaker();

  const record = (row: PooledFetchRow): void => {
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

  return mapWithConcurrency(jobs, concurrency, async ({ q, provider }) => {
    const base = {
      queryId: q.id,
      type: q.type,
      query: q.query,
      provider,
      ...(q.sharpness ? { sharpness: q.sharpness } : {}),
      ...(q.genre ? { genre: q.genre } : {}),
    };
    const emit = (row: PooledFetchRow): PooledFetchRow => {
      opts.onRow?.(row, ++landed, total);
      record(row);
      return row;
    };
    try {
      const start = Date.now();
      const fetched = await stage(
        "provider",
        fetchSources(provider, q.query, { ...DEFAULT_CONFIG }),
      );
      const fetch_ms = Date.now() - start;
      const { sources, fetched_at, from_cache } = fetched;
      return emit({
        ...base,
        num_sources: sources.length,
        num_extracted: sources.filter((s) => s.content).length,
        urls: returnedUrls(sources),
        sources,
        fetch_ms,
        fetched_at,
        from_cache,
      });
    } catch (e) {
      return emit({
        ...base,
        num_sources: 0,
        num_extracted: 0,
        urls: [],
        sources: [],
        error: e instanceof Error ? e.message : String(e),
        error_stage: stageOf(e),
      });
    }
  });
}

/**
 * What resume may skip: everything on disk that is actually evidence.
 *
 * Two kinds of failure are not evidence and must be tried again:
 *
 * - **transport** — measured this machine's connection, not the provider.
 * - **account** — measured the wallet. A 402 or "out of credits" at question
 *   150 says nothing whatever about the provider, and it is fixed by topping up
 *   and running again.
 *
 * Skipping account failures is the more dangerous of the two to get wrong,
 * because it fails quietly in the direction of a wrong published number: the
 * metered provider gets scored on the questions it reached, the rest land in
 * `n_excluded`, and nothing in the output says the comparison was uneven. Only
 * Firecrawl meters, so only Firecrawl could be silently under-measured — which
 * is precisely the arm a reader would look at hardest.
 */
export function resumableFetchKeys(rows: PooledFetchRow[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (isTransportFailure(r.error) || isAccountFailure(r.error)) continue;
    keys.add(fetchKey(r.queryId, r.provider));
  }
  return keys;
}

/** Last write wins per fetch; transport failures drop (resume retries them). */
export function dedupeFetchRows(rows: PooledFetchRow[]): PooledFetchRow[] {
  const latest = new Map<string, PooledFetchRow>();
  for (const r of rows) latest.set(fetchKey(r.queryId, r.provider), r);
  return [...latest.values()].filter((r) => !isTransportFailure(r.error));
}

// ─── phase 2: judge the pool ───

export interface PooledJudgementRow {
  queryId: string;
  url: string;
  judge: string; // short label — judgeLabel(ref)
  rung: number | null;
  rationale: string;
  /** The judge call itself threw (timeout, key, 429). Retried on resume. */
  error?: string;
}

export function judgementKey(queryId: string, url: string, judge: string): string {
  return `${queryId}|${url}|${judge}`;
}

export function poolFromFetchRows(rows: PooledFetchRow[]): PooledPage[] {
  return buildPool(
    rows
      .filter((r) => !r.error)
      .map((r) => ({
        queryId: r.queryId,
        query: r.query,
        provider: r.provider,
        sources: r.sources,
      })),
  );
}

export interface PooledJudgeOpts {
  concurrency?: number;
  onRow?: (row: PooledJudgementRow, done: number, total: number) => void;
  /** judgementKey()s already on disk (resume). */
  done?: ReadonlySet<string>;
  /** Submit through the providers' batch APIs at half price. Falls back to the
   *  synchronous path per provider — see completeBatch. */
  batch?: boolean;
  onProgress?: (status: string) => void;
}

export async function runPooledJudging(
  pool: PooledPage[],
  judges: string[],
  opts: PooledJudgeOpts = {},
): Promise<PooledJudgementRow[]> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const jobs = pool
    .flatMap((page) => judges.map((judgeRef) => ({ page, judgeRef })))
    .filter(
      ({ page, judgeRef }) =>
        !opts.done?.has(judgementKey(page.queryId, page.url, judgeLabel(judgeRef))),
    );
  const total = jobs.length;
  let landed = 0;

  if (opts.batch) {
    // The resume key IS the batch id for this request, which is the whole
    // reason batching drops in without touching resume: results come back
    // labelled with it, in any order, and map straight onto the same log.
    const outcomes = await completeBatch(
      jobs.map(({ page, judgeRef }) => ({
        customId: judgementKey(page.queryId, page.url, judgeLabel(judgeRef)),
        args: {
          model: judgeRef,
          temperature: RELEVANCE_JUDGE_TEMP,
          jsonMode: true,
          messages: relevanceMessages(page),
        },
      })),
      { onProgress: opts.onProgress },
    );
    const byId = new Map(outcomes.map((o) => [o.customId, o]));
    return jobs.map(({ page, judgeRef }) => {
      const base = { queryId: page.queryId, url: page.url, judge: judgeLabel(judgeRef) };
      const o = byId.get(judgementKey(page.queryId, page.url, judgeLabel(judgeRef)));
      const row: PooledJudgementRow =
        o?.text !== undefined
          ? { ...base, ...parseRungVerdict(o.text || "{}") }
          : { ...base, rung: null, rationale: "", error: o?.error ?? "no batch result" };
      opts.onRow?.(row, ++landed, total);
      return row;
    });
  }

  return mapWithConcurrency(jobs, concurrency, async ({ page, judgeRef }) => {
    const base = {
      queryId: page.queryId,
      url: page.url,
      judge: judgeLabel(judgeRef),
    };
    let row: PooledJudgementRow;
    try {
      const verdict = await stage("judge", relevanceJudge(page, judgeRef));
      row = { ...base, rung: verdict.rung, rationale: verdict.rationale };
    } catch (e) {
      row = {
        ...base,
        rung: null,
        rationale: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    opts.onRow?.(row, ++landed, total);
    return row;
  });
}

/** Resume skips judgements that landed; errored ones get another attempt. */
export function resumableJudgementKeys(rows: PooledJudgementRow[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.error) continue;
    keys.add(judgementKey(r.queryId, r.url, r.judge));
  }
  return keys;
}

export function dedupeJudgementRows(rows: PooledJudgementRow[]): PooledJudgementRow[] {
  const latest = new Map<string, PooledJudgementRow>();
  for (const r of rows) latest.set(judgementKey(r.queryId, r.url, r.judge), r);
  return [...latest.values()].filter((r) => !r.error);
}

// ─── phase 2b: judge each provider's returned set as a whole ───
// The per-page judge above answers "is this page any good"; this one answers
// "was this a good set to hand an agent", which a per-page mean only
// approximates — it can't see that four excellent pages all say the same thing,
// or that the one page carrying the answer sits at position eight.
//
// Cheaper than it looks: one call per (query × provider × judge) is roughly a
// third of the pair count, because pooling means the pair judge pays for every
// distinct page while this pays per returned set.
//
// Blinding is by construction again, though differently: a set belongs to
// exactly one provider, so instead of detaching pages from providers we simply
// never put a provider name in the prompt — see renderSources.

export interface PooledSetVerdictRow {
  queryId: string;
  provider: Provider;
  judge: string; // short label — judgeLabel(ref)
  /** 0–10, or null when the judge answered with something that wasn't a score.
   *  Null is counted and excluded, never folded into a real zero. */
  score: number | null;
  rationale: string;
  /** The judge call itself threw (timeout, key, 429). Retried on resume. */
  error?: string;
}

export function setVerdictKey(queryId: string, provider: Provider, judge: string): string {
  return `${queryId}|${provider}|${judge}`;
}

export interface PooledSetJudgeOpts {
  concurrency?: number;
  onRow?: (row: PooledSetVerdictRow, done: number, total: number) => void;
  /** setVerdictKey()s already on disk (resume). */
  done?: ReadonlySet<string>;
  batch?: boolean;
  onProgress?: (status: string) => void;
}

/** Rows worth judging: a failed fetch has no set to grade, and phase 3 already
 *  knows what a failure means (provider-fault is a miss, ours is excluded).
 *  Deciding that twice, in two places, is how the two answers drift apart. */
function judgeableRows(rows: PooledFetchRow[]): PooledFetchRow[] {
  return rows.filter((r) => !r.error && r.sources.length > 0);
}

export async function runSetJudging(
  rows: PooledFetchRow[],
  judges: string[],
  opts: PooledSetJudgeOpts = {},
): Promise<PooledSetVerdictRow[]> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const jobs = judgeableRows(rows)
    .flatMap((row) => judges.map((judgeRef) => ({ row, judgeRef })))
    .filter(
      ({ row, judgeRef }) =>
        !opts.done?.has(setVerdictKey(row.queryId, row.provider, judgeLabel(judgeRef))),
    );
  const total = jobs.length;
  let landed = 0;

  if (opts.batch) {
    const outcomes = await completeBatch(
      jobs.map(({ row, judgeRef }) => ({
        customId: setVerdictKey(row.queryId, row.provider, judgeLabel(judgeRef)),
        args: {
          model: judgeRef,
          temperature: RETRIEVAL_JUDGE_TEMP,
          jsonMode: true,
          messages: setJudgeMessages(row.query, row.sources),
        },
      })),
      { onProgress: opts.onProgress },
    );
    const byId = new Map(outcomes.map((o) => [o.customId, o]));
    return jobs.map(({ row, judgeRef }) => {
      const base = { queryId: row.queryId, provider: row.provider, judge: judgeLabel(judgeRef) };
      const o = byId.get(setVerdictKey(row.queryId, row.provider, judgeLabel(judgeRef)));
      const out: PooledSetVerdictRow =
        o?.text !== undefined
          ? { ...base, ...parseSetVerdict(o.text || "{}") }
          : { ...base, score: null, rationale: "", error: o?.error ?? "no batch result" };
      opts.onRow?.(out, ++landed, total);
      return out;
    });
  }

  return mapWithConcurrency(jobs, concurrency, async ({ row, judgeRef }) => {
    const base = {
      queryId: row.queryId,
      provider: row.provider,
      judge: judgeLabel(judgeRef),
    };
    let out: PooledSetVerdictRow;
    try {
      // stage("judge", …) so a judge timeout is never attributed to the
      // provider whose sources it happened to be reading.
      const verdict = await stage("judge", setJudge(row.query, row.sources, judgeRef));
      out = { ...base, score: verdict.score, rationale: verdict.rationale };
    } catch (e) {
      out = {
        ...base,
        score: null,
        rationale: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    opts.onRow?.(out, ++landed, total);
    return out;
  });
}

/** Resume skips set verdicts that landed; errored ones get another attempt. */
export function resumableSetVerdictKeys(rows: PooledSetVerdictRow[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.error) continue;
    keys.add(setVerdictKey(r.queryId, r.provider, r.judge));
  }
  return keys;
}

export function dedupeSetVerdictRows(rows: PooledSetVerdictRow[]): PooledSetVerdictRow[] {
  const latest = new Map<string, PooledSetVerdictRow>();
  for (const r of rows) latest.set(setVerdictKey(r.queryId, r.provider, r.judge), r);
  return [...latest.values()].filter((r) => !r.error);
}

// ─── phase 3: score providers against the pooled verdicts ───

export interface PooledProviderStat {
  provider: Provider;
  /** Queries this provider was actually measured on (misses included,
   *  our-fault exclusions not). The CI unit. */
  n_queries: number;
  /** Headline: mean rung (0–3) over the provider's returned links, averaged
   *  per query first. Unweighted — every returned link counts the same. */
  mean_rung: number;
  mean_rung_ci95: number;
  /** Binary collapse (rung ≥ RELEVANT_AT): fraction of returned links that
   *  were relevant. The robustness check beside the graded number. */
  precision: number;
  precision_ci95: number;
  /** Of the pooled relevant pages for a query, the fraction this provider
   *  returned. Only pooling makes this measurable at all. */
  recall: number;
  recall_ci95: number;
  n_recall_queries: number; // queries with ≥1 pooled relevant page
  n_attempts: number;
  n_misses: number; // provider-fault failures, scored 0 (failures are misses)
  n_excluded: number; // our-fault failures: excluded from scoring, published
  fetch_ms_p50: number | null;
  fetch_ms_p95: number | null;
  n_fetch_timed: number;
}

export interface PooledTypeStat extends PooledProviderStat {
  type: QueryType;
}

export interface PooledSharpnessStat extends PooledProviderStat {
  sharpness: Sharpness;
}

/** The provider comparison recomputed within one subject. The question this
 *  answers is the one a reader actually has: does the ranking hold outside
 *  software? A provider that leads on software and trails on sport is the case
 *  for publishing a map of specialities instead of a league table. */
export interface PooledGenreStat extends PooledProviderStat {
  genre: Genre;
}

/** The same pairwise agreement, computed over only the sharp questions or only
 *  the open ones. The reason the sharpness tag exists: judges are expected to
 *  agree less when several pages could each legitimately be the right answer,
 *  and that expectation should be checked rather than assumed. If agreement
 *  holds up on both, the tag has told us something; if it collapses on open
 *  questions, the headline number is carrying the disagreement. */
export interface PooledSharpnessAgreementStat extends PooledAgreementStat {
  sharpness: Sharpness;
}

export interface PooledAgreementStat {
  judge_a: string;
  judge_b: string;
  /** Raw agreement: fraction of shared pairs given the identical rung. */
  raw_agreement: number;
  /** Cohen's kappa — agreement above what the two judges' own rating habits
   *  would produce by chance. Reported WITH raw + distribution, never alone:
   *  when one rung dominates, kappa collapses (the kappa paradox) and reads
   *  as "worse than random" next to 95% raw agreement. */
  kappa: number;
  n: number;
}

/** How lopsided a judge's ratings were — the context that explains why raw
 *  agreement and kappa can disagree about the same panel. */
export interface RungDistribution {
  judge: string;
  counts: [number, number, number, number]; // rungs 0..3
  n_null: number; // verdicts that weren't a rung (unparseable / off-scale)
}

export interface VarianceShares {
  /** Fraction of total score variation attributable to each source, from a
   *  sums-of-squares decomposition over (query × provider × judge) cell means.
   *  provider ≈ 0 with a large provider_by_query share is the 2026 finding —
   *  specialities, not general ability — and decides map vs ranking. */
  provider: number;
  query: number;
  judge: number;
  provider_by_query: number;
  residual: number;
  n_cells: number;
}

/** A provider's set-level result: the whole returned set graded 0–10, averaged
 *  per query first so the confidence interval is over questions — the same unit
 *  as every other interval this run publishes. Kept apart from
 *  PooledProviderStat rather than folded into it, because the two numbers come
 *  from different judges on different scales and averaging them together would
 *  invent a measurement nobody made. */
export interface PooledSetStat {
  provider: Provider;
  /** Queries this provider was measured on, misses included. The CI unit. */
  n_queries: number;
  mean_score: number;
  mean_score_ci95: number;
  n_misses: number; // provider-fault failures, scored 0 — a failure is a miss
  n_excluded: number; // our-fault failures, and sets no judge could grade
}

export interface PooledSummary {
  generated_at: string;
  judges: string[];
  providers: Provider[];
  n_queries: number;
  n_pairs: number;
  n_judgements: number;
  n_null_rungs: number;
  n_judge_errors: number;
  n_unjudged_pairs: number;
  by_provider: PooledProviderStat[];
  /** Empty unless the run judged whole sets (`--set-judge`). */
  by_provider_set: PooledSetStat[];
  n_set_verdicts: number;
  /** Judges that answered with something that wasn't a score. Loud on purpose. */
  n_set_null_scores: number;
  n_set_judge_errors: number;
  by_type: PooledTypeStat[];
  /** Empty when no query in the set carried a sharpness tag — the built-in 48
   *  don't, so a run over them simply has no slice rather than a fake one. */
  by_sharpness: PooledSharpnessStat[];
  /** Empty when no question in the set carried a genre tag. */
  by_genre: PooledGenreStat[];
  agreement: PooledAgreementStat[];
  agreement_by_sharpness: PooledSharpnessAgreementStat[];
  rung_distribution: RungDistribution[];
  variance_shares: VarianceShares;
}

/** Panel verdict per pair: mean rung across judges that returned a rung. */
export function panelMeans(judgements: PooledJudgementRow[]): Map<string, number> {
  const byPair = new Map<string, number[]>();
  for (const j of judgements) {
    if (j.rung === null) continue;
    const key = pairKey(j.queryId, j.url);
    (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(j.rung);
  }
  const means = new Map<string, number>();
  for (const [key, rungs] of byPair) means.set(key, mean(rungs));
  return means;
}

interface QueryScore {
  mean_rung: number;
  precision: number;
  recall: number | null; // null when the query had no pooled relevant page
}

/**
 * Score one provider on one query against the pooled verdicts.
 *
 * A miss (provider-fault failure, or a successful call that returned nothing)
 * scores zero on all three — the provider didn't return the pages. Returns
 * null when the row can't be scored at all: an our-fault failure, or a
 * returned set none of whose pages ever got a valid panel verdict.
 */
export function scoreQuery(
  row: PooledFetchRow,
  verdicts: Map<string, number>,
  relevant: ReadonlySet<string>,
  relevantCount: number,
): QueryScore | null {
  const zero = (): QueryScore => ({
    mean_rung: 0,
    precision: 0,
    recall: relevantCount > 0 ? 0 : null,
  });
  if (row.error) {
    return isProviderFailure(row.error, row.error_stage) ? zero() : null;
  }
  if (!row.urls.length) return zero();

  const rungs: number[] = [];
  let hits = 0;
  for (const url of row.urls) {
    const rung = verdicts.get(pairKey(row.queryId, url));
    if (rung === undefined) continue; // pair never got a valid verdict
    rungs.push(rung);
    if (relevant.has(pairKey(row.queryId, url))) hits++;
  }
  if (!rungs.length) return null; // nothing judged — not a measurement
  return {
    mean_rung: mean(rungs),
    precision: rungs.filter((r) => r >= RELEVANT_AT).length / rungs.length,
    recall: relevantCount > 0 ? hits / relevantCount : null,
  };
}

function providerStat(
  rows: PooledFetchRow[],
  verdicts: Map<string, number>,
  relevantByQuery: Map<string, Set<string>>,
  provider: Provider,
): PooledProviderStat {
  const attempted = rows.filter((r) => r.provider === provider);
  const rungMeans: number[] = [];
  const precisions: number[] = [];
  const recalls: number[] = [];
  let misses = 0;
  let excluded = 0;

  for (const row of attempted) {
    const relevant = relevantByQuery.get(row.queryId) ?? new Set<string>();
    const score = scoreQuery(row, verdicts, relevant, relevant.size);
    if (score === null) {
      excluded++;
      continue;
    }
    if (row.error || !row.urls.length) misses++;
    rungMeans.push(score.mean_rung);
    precisions.push(score.precision);
    if (score.recall !== null) recalls.push(score.recall);
  }

  const fetchMs = attempted
    .map((r) => r.fetch_ms)
    .filter((ms): ms is number => typeof ms === "number");

  return {
    provider,
    n_queries: rungMeans.length,
    mean_rung: Number(mean(rungMeans).toFixed(3)),
    mean_rung_ci95: Number(ci95(rungMeans).toFixed(3)),
    precision: Number(mean(precisions).toFixed(3)),
    precision_ci95: Number(ci95(precisions).toFixed(3)),
    recall: Number(mean(recalls).toFixed(3)),
    recall_ci95: Number(ci95(recalls).toFixed(3)),
    n_recall_queries: recalls.length,
    n_attempts: attempted.length,
    n_misses: misses,
    n_excluded: excluded,
    fetch_ms_p50: percentile(fetchMs, 0.5),
    fetch_ms_p95: percentile(fetchMs, 0.95),
    n_fetch_timed: fetchMs.length,
  };
}

/**
 * A provider's set-level score, by the same rules phase 3 uses for rungs: a
 * provider-fault failure is a miss and scores 0, an our-fault failure is
 * excluded and published, and a set no judge could grade is not a measurement.
 * The rules are deliberately identical so the two headline numbers can't
 * disagree for a reason that has nothing to do with retrieval.
 */
function setStat(
  rows: PooledFetchRow[],
  verdicts: PooledSetVerdictRow[],
  provider: Provider,
): PooledSetStat {
  const byRow = new Map<string, number[]>();
  for (const v of verdicts) {
    if (v.score === null || v.provider !== provider) continue;
    const key = setVerdictKey(v.queryId, v.provider, "");
    (byRow.get(key) ?? byRow.set(key, []).get(key)!).push(v.score);
  }

  const attempted = rows.filter((r) => r.provider === provider);
  const scores: number[] = [];
  let misses = 0;
  let excluded = 0;

  for (const row of attempted) {
    if (row.error) {
      if (isProviderFailure(row.error, row.error_stage)) {
        misses++;
        scores.push(0);
      } else {
        excluded++;
      }
      continue;
    }
    if (!row.urls.length) {
      misses++;
      scores.push(0);
      continue;
    }
    const graded = byRow.get(setVerdictKey(row.queryId, provider, ""));
    if (!graded?.length) {
      excluded++; // nothing gradeable came back — not a measurement
      continue;
    }
    scores.push(mean(graded));
  }

  return {
    provider,
    n_queries: scores.length,
    mean_score: Number(mean(scores).toFixed(3)),
    mean_score_ci95: Number(ci95(scores).toFixed(3)),
    n_misses: misses,
    n_excluded: excluded,
  };
}

function agreementFor(
  judgements: PooledJudgementRow[],
  ja: string,
  jb: string,
): PooledAgreementStat {
  const byPair = new Map<string, { a?: number; b?: number }>();
  for (const j of judgements) {
    if (j.rung === null || (j.judge !== ja && j.judge !== jb)) continue;
    const key = pairKey(j.queryId, j.url);
    const cell = byPair.get(key) ?? byPair.set(key, {}).get(key)!;
    if (j.judge === ja) cell.a = j.rung;
    else cell.b = j.rung;
  }
  const pairs = [...byPair.values()].filter(
    (c): c is { a: number; b: number } => c.a !== undefined && c.b !== undefined,
  );
  const n = pairs.length;
  if (!n) return { judge_a: ja, judge_b: jb, raw_agreement: 0, kappa: 0, n: 0 };

  const po = pairs.filter((c) => c.a === c.b).length / n;
  // Chance agreement from each judge's own rating habits (marginals).
  const margA = [0, 0, 0, 0];
  const margB = [0, 0, 0, 0];
  for (const c of pairs) {
    margA[c.a]++;
    margB[c.b]++;
  }
  const pe = margA.reduce((s, cnt, k) => s + (cnt / n) * (margB[k] / n), 0);
  // pe → 1 means both judges near-constant; kappa is undefined there, and 0 is
  // the honest render: no evidence of agreement beyond habit.
  const kappa = pe >= 1 ? 0 : (po - pe) / (1 - pe);
  return {
    judge_a: ja,
    judge_b: jb,
    raw_agreement: Number(po.toFixed(3)),
    kappa: Number(kappa.toFixed(3)),
    n,
  };
}

function rungDistributions(judgements: PooledJudgementRow[]): RungDistribution[] {
  const byJudge = new Map<string, RungDistribution>();
  for (const j of judgements) {
    const d =
      byJudge.get(j.judge) ??
      byJudge.set(j.judge, { judge: j.judge, counts: [0, 0, 0, 0], n_null: 0 }).get(j.judge)!;
    if (j.rung === null) d.n_null++;
    else d.counts[j.rung]++;
  }
  return [...byJudge.values()];
}

/**
 * Split score variation into named parts over (query × provider × judge) cells,
 * where a cell is one judge's mean rung for one provider's returned set on one
 * query. Sums-of-squares shares — approximate under missing cells, and labeled
 * as shares rather than tested effects. Its job is the one decision it feeds:
 * if `provider` is small while `provider_by_query` is large, the honest output
 * is a map, not a ranking.
 */
export function varianceShares(
  cells: { query: string; provider: string; judge: string; value: number }[],
): VarianceShares {
  const empty: VarianceShares = {
    provider: 0, query: 0, judge: 0, provider_by_query: 0, residual: 0,
    n_cells: cells.length,
  };
  if (cells.length < 2) return empty;
  const grand = mean(cells.map((c) => c.value));
  const groupMeans = (key: (c: (typeof cells)[number]) => string): Map<string, number> => {
    const groups = new Map<string, number[]>();
    for (const c of cells) {
      const k = key(c);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c.value);
    }
    return new Map([...groups].map(([k, xs]) => [k, mean(xs)]));
  };
  const mQ = groupMeans((c) => c.query);
  const mP = groupMeans((c) => c.provider);
  const mJ = groupMeans((c) => c.judge);
  const mQP = groupMeans((c) => `${c.query}|${c.provider}`);

  let ssTotal = 0, ssQ = 0, ssP = 0, ssJ = 0, ssQP = 0;
  for (const c of cells) {
    ssTotal += (c.value - grand) ** 2;
    ssQ += (mQ.get(c.query)! - grand) ** 2;
    ssP += (mP.get(c.provider)! - grand) ** 2;
    ssJ += (mJ.get(c.judge)! - grand) ** 2;
    const inter =
      mQP.get(`${c.query}|${c.provider}`)! -
      mQ.get(c.query)! -
      mP.get(c.provider)! +
      grand;
    ssQP += inter ** 2;
  }
  if (ssTotal === 0) return empty;
  const share = (ss: number): number => Number((ss / ssTotal).toFixed(3));
  const residual = Math.max(0, ssTotal - ssQ - ssP - ssJ - ssQP);
  return {
    provider: share(ssP),
    query: share(ssQ),
    judge: share(ssJ),
    provider_by_query: share(ssQP),
    residual: share(residual),
    n_cells: cells.length,
  };
}

/** Per-judge verdicts per pair, for the variance cells. */
function judgeVerdicts(judgements: PooledJudgementRow[]): Map<string, Map<string, number>> {
  const byJudge = new Map<string, Map<string, number>>();
  for (const j of judgements) {
    if (j.rung === null) continue;
    const m = byJudge.get(j.judge) ?? byJudge.set(j.judge, new Map()).get(j.judge)!;
    m.set(pairKey(j.queryId, j.url), j.rung);
  }
  return byJudge;
}

export function summarizePooled(
  rawFetches: PooledFetchRow[],
  rawJudgements: PooledJudgementRow[],
  meta: { judges: string[]; now: number; setVerdicts?: PooledSetVerdictRow[] },
): PooledSummary {
  const fetches = dedupeFetchRows(rawFetches);
  const judgements = dedupeJudgementRows(rawJudgements);
  const judgeErrors = rawJudgements.filter((r) => r.error).length;
  const rawSetVerdicts = meta.setVerdicts ?? [];
  const setVerdicts = dedupeSetVerdictRows(rawSetVerdicts);

  const verdicts = panelMeans(judgements);
  const allPairs = new Set(judgements.map((j) => pairKey(j.queryId, j.url)));

  // The pooled relevant set per query: pairs whose panel mean clears the bar.
  const relevantByQuery = new Map<string, Set<string>>();
  for (const [key, rung] of verdicts) {
    if (rung < RELEVANT_AT) continue;
    const queryId = key.slice(0, key.indexOf("|"));
    (relevantByQuery.get(queryId) ?? relevantByQuery.set(queryId, new Set()).get(queryId)!).add(key);
  }

  const providers = [...new Set(fetches.map((r) => r.provider))];
  const types = [...new Set(fetches.map((r) => r.type))];

  const byType: PooledTypeStat[] = [];
  for (const type of types) {
    const sub = fetches.filter((r) => r.type === type);
    for (const provider of providers) {
      byType.push({ ...providerStat(sub, verdicts, relevantByQuery, provider), type });
    }
  }

  // Sharpness comes off the fetch rows, not the query file — see PooledFetchRow.
  // A set with no tags produces no slices at all rather than one empty bucket.
  const sharpnessOf = new Map<string, Sharpness>();
  for (const r of fetches) if (r.sharpness) sharpnessOf.set(r.queryId, r.sharpness);
  const sharpnesses = [...new Set(sharpnessOf.values())];

  const bySharpness: PooledSharpnessStat[] = [];
  for (const sharpness of sharpnesses) {
    const sub = fetches.filter((r) => r.sharpness === sharpness);
    for (const provider of providers) {
      bySharpness.push({ ...providerStat(sub, verdicts, relevantByQuery, provider), sharpness });
    }
  }

  // Genre slices, on the same rule as sharpness: a set with no tags produces
  // no slices at all rather than one bucket labelled "undefined".
  const genreOf = new Map<string, Genre>();
  for (const r of fetches) if (r.genre) genreOf.set(r.queryId, r.genre);
  const genres = [...new Set(genreOf.values())];

  const byGenre: PooledGenreStat[] = [];
  for (const genre of genres) {
    const sub = fetches.filter((r) => r.genre === genre);
    for (const provider of providers) {
      byGenre.push({ ...providerStat(sub, verdicts, relevantByQuery, provider), genre });
    }
  }

  const labels = meta.judges.map(judgeLabel);
  const agreement: PooledAgreementStat[] = [];
  const agreementBySharpness: PooledSharpnessAgreementStat[] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let k = i + 1; k < labels.length; k++) {
      agreement.push(agreementFor(judgements, labels[i], labels[k]));
      for (const sharpness of sharpnesses) {
        const sub = judgements.filter((j) => sharpnessOf.get(j.queryId) === sharpness);
        agreementBySharpness.push({ ...agreementFor(sub, labels[i], labels[k]), sharpness });
      }
    }
  }

  // Variance cells: one judge's mean rung over one provider's returned set on
  // one query — only for rows that were real measurements.
  const cells: { query: string; provider: string; judge: string; value: number }[] = [];
  const perJudge = judgeVerdicts(judgements);
  for (const row of fetches) {
    if (row.error || !row.urls.length) continue;
    for (const [judge, vmap] of perJudge) {
      const rungs = row.urls
        .map((url) => vmap.get(pairKey(row.queryId, url)))
        .filter((r): r is number => r !== undefined);
      if (rungs.length) {
        cells.push({ query: row.queryId, provider: row.provider, judge, value: mean(rungs) });
      }
    }
  }

  return {
    generated_at: new Date(meta.now).toISOString(),
    judges: meta.judges,
    providers,
    n_queries: new Set(fetches.map((r) => r.queryId)).size,
    n_pairs: allPairs.size,
    n_judgements: judgements.length,
    n_null_rungs: judgements.filter((j) => j.rung === null).length,
    n_judge_errors: judgeErrors,
    n_unjudged_pairs: [...allPairs].filter((k) => !verdicts.has(k)).length,
    by_provider: providers.map((p) => providerStat(fetches, verdicts, relevantByQuery, p)),
    by_provider_set: setVerdicts.length
      ? providers.map((p) => setStat(fetches, setVerdicts, p))
      : [],
    n_set_verdicts: setVerdicts.length,
    n_set_null_scores: setVerdicts.filter((v) => v.score === null).length,
    n_set_judge_errors: rawSetVerdicts.filter((v) => v.error).length,
    by_type: byType,
    by_sharpness: bySharpness,
    by_genre: byGenre,
    agreement,
    agreement_by_sharpness: agreementBySharpness,
    rung_distribution: rungDistributions(judgements),
    variance_shares: varianceShares(cells),
  };
}
