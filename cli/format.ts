import type { Arm, Run } from "@core/types";
import type { BatchOutput } from "@core/batch";
import type { CredibilitySummary } from "@core/credibility";
import { ADAPTERS } from "@core/adapters";

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
    "ARM  " +
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
    : "Winner: none (all arms failed)";

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

/** Render a batch's provider heatmap (avg retrieval score per query type). */
export function renderBatch(out: BatchOutput): string {
  const fmt = (n: number) => n.toFixed(1);
  const rows = out.heatmap.map((h) => ({
    label: h.label,
    bright_data: fmt(h.bright_data),
    firecrawl: fmt(h.firecrawl),
    // Which provider retrieved better for this type (blank on a tie).
    lead:
      h.bright_data === h.firecrawl
        ? ""
        : h.bright_data > h.firecrawl
          ? "Bright Data"
          : "Firecrawl",
  }));

  const wLabel = Math.max("TYPE".length, ...rows.map((r) => r.label.length));
  const wBd = Math.max("BRIGHT DATA".length, ...rows.map((r) => r.bright_data.length));
  const wFc = Math.max("FIRECRAWL".length, ...rows.map((r) => r.firecrawl.length));

  const header =
    "  " +
    pad("TYPE", wLabel) +
    "  " +
    pad("BRIGHT DATA", wBd) +
    "  " +
    pad("FIRECRAWL", wFc) +
    "  LEADS";

  const body = rows.map(
    (r) =>
      "  " +
      pad(r.label, wLabel) +
      "  " +
      pad(r.bright_data, wBd) +
      "  " +
      pad(r.firecrawl, wFc) +
      (r.lead ? `  ${r.lead}` : ""),
  );

  return [
    `Batch — ${out.rows.length} arms, ${out.runs_per_cell} run(s)/cell`,
    `Generated: ${out.generated_at}`,
    "avg retrieval score (0–10) by query type:",
    "",
    header,
    ...body,
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
    "",
    "Inter-judge agreement:",
    ...agreeLines,
    "",
    "Variance decomposition (retrieval_score, the primary metric):",
    `  seed noise (std across seeds, avg):   ${s.variance.seed_std_mean.toFixed(3)}`,
    `  judge gap (|A−B|, avg):               ${s.variance.judge_gap_mean.toFixed(3)}`,
  ].join("\n");
}
