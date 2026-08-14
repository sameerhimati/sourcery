import type { Arm, Run } from "@core/types";
import type { BatchOutput } from "@core/batch";
import type { CredibilitySummary } from "@core/credibility";
import type { PooledSummary } from "@core/pooled";
import { ADAPTERS } from "@core/adapters";
import { providerMeta } from "@core/viz";
import { SEED_NOISE } from "@core/controls";

// Terminal scorecard — a plain-text view over a Run. Kept color-free and pure
// (Run in, string out) so it snapshots deterministically in tests; the HTML
// report is where visual polish lives.

// Display names come from the adapter registry so a new provider is labelled
// correctly here without a second list to forget to update.
const label = (p: string) => ADAPTERS[p]?.label ?? p;
const score = (n: number) => `${n}/10`;

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

/** Render a single-query Run as an aligned scorecard block. */
export function renderRun(run: Run): string {
  const rows = run.arms.map((a: Arm) => ({
    mark: a.id === run.winner ? "★" : " ",
    id: a.id,
    provider: label(a.provider),
    retrieval: a.error ? "—" : score(a.retrieval_score),
    answer: a.error ? "—" : score(a.score),
    latency: a.error ? "—" : `${a.latency_ms}ms`,
    note: a.error ?? "",
  }));

  const cols = [
    { key: "provider", head: "PROVIDER" },
    { key: "retrieval", head: "RETRIEVAL" },
    { key: "answer", head: "ANSWER" },
    { key: "latency", head: "LATENCY" },
  ] as const;

  const width = (key: (typeof cols)[number]["key"], head: string) =>
    Math.max(head.length, ...rows.map((r) => r[key].length));

  const header =
    "   " +
    "#    " +
    cols.map((c) => pad(c.head, width(c.key, c.head))).join("  ");

  const body = rows.map((r) => {
    const line =
      ` ${r.mark} ` +
      pad(r.id, 4) +
      " " +
      cols.map((c) => pad(r[c.key], width(c.key, c.head))).join("  ");
    return r.note ? `${line}   (${r.note})` : line;
  });

  const winner = run.arms.find((a) => a.id === run.winner);
  const footer = winner
    ? `Winner: ${winner.id} (${label(winner.provider)}) — retrieval ${score(winner.retrieval_score)}`
    : "Winner: none (every provider failed)";

  // Per-arm retrieved sources (domains) so you can see what each arm actually got.
  const sourceLines = run.arms
    .filter((a) => a.sources.length)
    .map((a) => {
      const domains = a.sources.map((s) => s.domain).join(", ");
      return `  ${a.id} (${label(a.provider)}): ${domains}`;
    });
  const sources = sourceLines.length ? ["", "Sources:", ...sourceLines] : [];

  return [
    `Query: ${run.query}`,
    `Varying: ${run.variable}  ·  Judge: ${run.judge_model}`,
    "",
    header,
    ...body,
    "",
    footer,
    ...sources,
  ].join("\n");
}

/** Render a batch's provider heatmap (avg retrieval score per query type).
 *  Columns are whatever providers the batch actually ran — one column each,
 *  however many that is. */
export function renderBatch(out: BatchOutput): string {
  const fmt = (n: number) => n.toFixed(1);
  const providers = out.providers?.length ? out.providers : Object.keys(out.heatmap[0]?.scores ?? {});
  const heads = providers.map((p) => providerMeta(p).label.toUpperCase());

  const rows = out.heatmap.map((h) => {
    const cells = providers.map((p) => fmt(h.scores[p] ?? 0));
    // Which provider retrieved better for this type — but only when the gap is
    // big enough to mean anything. Blank on a tie, including a tie at the top
    // among three or more, which a single "leads" name would misreport as a
    // clean win.
    const scores = providers.map((p) => h.scores[p] ?? 0);
    const best = Math.max(...scores);
    const runnerUp = Math.max(...scores.filter((s) => s !== best), -Infinity);
    const winners = providers.filter((p) => (h.scores[p] ?? 0) === best);
    const gap = Number.isFinite(runnerUp) ? best - runnerUp : Infinity;
    return {
      label: h.label,
      cells,
      // A gap under the re-run noise floor is not a lead, it's a coin flip. This
      // column read as a verdict while the "1 run(s)/cell" caption did all the
      // hedging — the exact mistake the 480-arm run exists to catch, committed
      // by the tool that reported it.
      lead: winners.length === 1 && gap >= SEED_NOISE ? providerMeta(winners[0]).label : "",
      tooClose: winners.length === 1 && gap < SEED_NOISE,
    };
  });

  const wLabel = Math.max("TYPE".length, ...rows.map((r) => r.label.length));
  const wCols = providers.map((_, i) =>
    Math.max(heads[i].length, ...rows.map((r) => r.cells[i].length)),
  );

  const header =
    "  " +
    pad("TYPE", wLabel) +
    heads.map((h, i) => "  " + pad(h, wCols[i])).join("") +
    "  LEADS";

  const body = rows.map(
    (r) =>
      "  " +
      pad(r.label, wLabel) +
      r.cells.map((c, i) => "  " + pad(c, wCols[i])).join("") +
      (r.lead ? `  ${r.lead}` : r.tooClose ? "  too close to call" : ""),
  );

  // Say what the reader is looking at. A single run per cell cannot separate a
  // provider difference from re-run noise, and the table should admit that
  // rather than let a confident-looking grid imply otherwise.
  const caveat =
    out.runs_per_cell <= 1
      ? `\n1 run per cell: re-running the same query moves this score by ~${SEED_NOISE.toFixed(1)}\n` +
        `on its own, so treat single-run gaps as a hint about where to look, not a result.`
      : "";

  return [
    `Batch — ${out.rows.length} results, ${out.runs_per_cell} run(s)/cell`,
    `Generated: ${out.generated_at}`,
    "avg retrieval score (0–10) by query type:",
    "",
    header,
    ...body,
    caveat,
  ].join("\n");
}

/** Render the S2 credibility summary: per-provider means±CI, judge agreement,
 *  and the seed-vs-judge variance decomposition. Pure (summary in, string out). */
export function renderCredibility(s: CredibilitySummary): string {
  const meanCi = (m: number, ci: number) => `${m.toFixed(2)} ± ${ci.toFixed(2)}`;

  // Per-provider block.
  const provRows = s.by_provider.map((p) => ({
    provider: label(p.provider),
    retrieval: meanCi(p.retrieval_mean, p.retrieval_ci95),
    answer: meanCi(p.answer_mean, p.answer_ci95),
    n: String(p.n_queries),
  }));
  const wP = Math.max("PROVIDER".length, ...provRows.map((r) => r.provider.length));
  const wR = Math.max("RETRIEVAL (95% CI)".length, ...provRows.map((r) => r.retrieval.length));
  const wA = Math.max("ANSWER (95% CI)".length, ...provRows.map((r) => r.answer.length));
  const provHeader =
    "  " + pad("PROVIDER", wP) + "  " + pad("RETRIEVAL (95% CI)", wR) +
    "  " + pad("ANSWER (95% CI)", wA) + "  N";
  const provBody = provRows.map(
    (r) => "  " + pad(r.provider, wP) + "  " + pad(r.retrieval, wR) +
      "  " + pad(r.answer, wA) + "  " + r.n,
  );

  // Provider latency block — fetch_ms only, and only for providers that actually
  // carry it. Printed separately from the score table rather than as a column,
  // because a run that mixes pre-fetch_ms rows with new ones would otherwise show
  // a blank cell that reads like "fast" instead of "not measured".
  const timed = s.by_provider.filter((p) => p.n_fetch_timed > 0);
  const latencyLines = timed.length
    ? [
        "",
        "Provider latency — the retrieval call alone, not the answer or the judges:",
        "",
        ...timed.map((p) => {
          const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
          const coverage =
            p.n_fetch_timed < p.n_arms ? `  (${p.n_fetch_timed} of ${p.n_arms} arms timed)` : "";
          return `  ${pad(label(p.provider), 12)}  p50 ${pad(secs(p.fetch_ms_p50), 7)}  p95 ${pad(secs(p.fetch_ms_p95), 7)}${coverage}`;
        }),
      ]
    : [
        "",
        "Provider latency: not measured in this run — no arm carried a fetch_ms.",
      ];

  // Inter-judge agreement block.
  const agreeLines = s.agreement.map(
    (a) =>
      `  ${a.metric.padEnd(9)} ${a.judge_a} vs ${a.judge_b}: ` +
      `r=${a.pearson.toFixed(2)}  mean|Δ|=${a.mean_abs_diff.toFixed(2)}  ` +
      `within±1=${(a.within_1_rate * 100).toFixed(0)}%  (n=${a.n})`,
  );

  return [
    `Credibility run — ${s.n_rows} rows (${s.n_queries} queries × ` +
      `${s.providers.map(label).join(" / ")} × ${s.seeds} seeds), ${s.n_errors} errors` +
      (s.n_unparseable_judgements
        ? `\n⚠ ${s.n_unparseable_judgements} judge verdict(s) were unparseable and scored 0 — ` +
          `these drag the means down and are NOT genuine zeros.`
        : ""),
    `Answer: ${s.answer_model}`,
    `Judges: ${s.judges.map((j) => j.split("/").pop()).join(", ")}`,
    `Generated: ${s.generated_at}`,
    "",
    "Retrieval / answer score (0–10), mean over queries with 95% CI:",
    "",
    provHeader,
    ...provBody,
    ...latencyLines,
    "",
    "Inter-judge agreement:",
    ...agreeLines,
    "",
    "Variance decomposition (retrieval_score, the primary metric):",
    `  seed noise (std across seeds, avg):   ${s.variance.seed_std_mean.toFixed(3)}`,
    `  judge gap (|A−B|, avg):               ${s.variance.judge_gap_mean.toFixed(3)}`,
  ].join("\n");
}

/** Render the pooled-run summary. Pure (summary in, string out), like the rest
 *  of this file. Every statistic is said in words where it appears, because
 *  this block is the first thing a reader meets after a two-hour run. */
export function renderPooled(s: PooledSummary): string {
  const meanCi = (m: number, ci: number) => `${m.toFixed(2)} ± ${ci.toFixed(2)}`;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  const rows = s.by_provider.map((p) => ({
    provider: label(p.provider),
    rung: meanCi(p.mean_rung, p.mean_rung_ci95),
    precision: meanCi(p.precision, p.precision_ci95),
    recall: p.n_recall_queries ? meanCi(p.recall, p.recall_ci95) : "—",
    misses: String(p.n_misses),
    excluded: String(p.n_excluded),
    n: String(p.n_queries),
  }));
  const w = (head: string, key: keyof (typeof rows)[number]) =>
    Math.max(head.length, ...rows.map((r) => r[key].length));
  const cols: { head: string; key: keyof (typeof rows)[number] }[] = [
    { head: "PROVIDER", key: "provider" },
    { head: "MEAN RUNG (0–3)", key: "rung" },
    { head: "PRECISION", key: "precision" },
    { head: "RECALL", key: "recall" },
    { head: "MISSES", key: "misses" },
    { head: "EXCL", key: "excluded" },
    { head: "N", key: "n" },
  ];
  const header = "  " + cols.map((c) => pad(c.head, w(c.head, c.key))).join("  ");
  const body = rows.map(
    (r) => "  " + cols.map((c) => pad(r[c.key], w(c.head, c.key))).join("  "),
  );

  const timed = s.by_provider.filter((p) => p.n_fetch_timed > 0);
  const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const latency = timed.length
    ? [
        "",
        "Provider latency — the retrieval call alone:",
        ...timed.map(
          (p) => `  ${pad(label(p.provider), 12)}  p50 ${pad(secs(p.fetch_ms_p50), 7)}  p95 ${secs(p.fetch_ms_p95)}`,
        ),
      ]
    : [];

  const agree = s.agreement.map(
    (a) =>
      `  ${a.judge_a} vs ${a.judge_b}: agreed exactly on ${pct(a.raw_agreement)} of pairs; ` +
      `kappa ${a.kappa.toFixed(2)} (agreement beyond each judge's own habits)  (n=${a.n})`,
  );

  const dist = s.rung_distribution.map((d) => {
    const total = d.counts.reduce((a, b) => a + b, 0) + d.n_null;
    const parts = d.counts.map((c, rung) => `${rung}:${c}`).join("  ");
    return `  ${pad(d.judge, 12)}  ${parts}` + (d.n_null ? `  none:${d.n_null}` : "") + `  (of ${total})`;
  });

  const v = s.variance_shares;
  const mapNotRanking =
    v.n_cells > 0 && v.provider < 0.05 && v.provider_by_query > v.provider * 2
      ? [
          "",
          "  Which provider you use explains almost none of the variation, while",
          "  provider-by-question explains more — providers have specialities, not",
          "  general ability. The honest output of this run is a map, not a ranking.",
        ]
      : [];

  return [
    `Pooled run — ${s.n_queries} queries × ${s.providers.map(label).join(" / ")}, ` +
      `${s.n_pairs} unique question-page pairs, judged by ${s.judges.length} judge(s)`,
    `Generated: ${s.generated_at}`,
    (s.n_null_rungs
      ? `⚠ ${s.n_null_rungs} verdict(s) were not a valid rung — counted, never scored as 0.\n`
      : "") +
      (s.n_judge_errors
        ? `⚠ ${s.n_judge_errors} judge call(s) errored — resume retries them.\n`
        : "") +
      (s.n_unjudged_pairs
        ? `⚠ ${s.n_unjudged_pairs} pair(s) never got a valid verdict from any judge.\n`
        : ""),
    "Mean rung is graded relevance 0–3 averaged over a provider's returned links.",
    "Precision: share of returned links that were relevant (rung ≥ 2). Recall:",
    "share of all relevant pooled pages the provider returned. Misses are",
    "provider-fault failures scored 0; excluded rows are our fault, never scored.",
    "",
    header,
    ...body,
    ...latency,
    "",
    "Judge agreement (read the three together — each alone can mislead):",
    ...agree,
    "",
    "How each judge used the scale (rung: count):",
    ...dist,
    "",
    "Where the score variation comes from (shares of total):",
    `  provider ${pct(v.provider)} · question ${pct(v.query)} · ` +
      `provider×question ${pct(v.provider_by_query)} · judge ${pct(v.judge)} · ` +
      `residual ${pct(v.residual)}`,
    ...mapNotRanking,
  ].join("\n");
}
