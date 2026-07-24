import type { Command } from "commander";
import { runCredibility, summarize } from "@core/credibility";
import { selectQueries } from "@core/batch";
import { MODEL } from "@core/controls";
import { requiredEnvKeys } from "@core/llm";
import { loadEnv, requireKeys } from "../env";
import { loadConfig } from "../config";
import { writeCredibility, S2_RUNS_PATH, S2_SUMMARY_PATH } from "../persist";
import { renderCredibility } from "../format";

// S2 credibility run: the full 48 × seeds × 2 providers matrix graded by a JUDGE
// PANEL, producing confidence intervals + inter-judge agreement. Separate from
// `batch` (which is single-judge, single-seed) so the live/dashboard path stays
// untouched. Slow + credit-heavy — start with --per-type for a dry run.
export function registerCredibility(program: Command): void {
  program
    .command("credibility")
    .description("S2: 48 × seeds × 2 providers, judge panel → CIs + judge agreement")
    .option("--seeds <n>", "fresh-fetch repeats per (query × provider)", "5")
    .option("--judges <list>", "comma-separated judge model refs (the panel)")
    .option("--model <model>", "answer model (held constant across arms)")
    .option("--per-type <n>", "cap queries per type for a dry run (0 = full 48)", "0")
    .option("--concurrency <n>", "pipelines in flight (higher = faster, more load)", "4")
    .option("--no-save", "do not write .sourcery/s2-*.{jsonl,json}")
    .action(async (opts: CredOptions) => {
      loadEnv();
      const config = await loadConfig();

      const model = opts.model ?? config.model ?? MODEL;
      const judges = (opts.judges ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (judges.length < 1) {
        throw new Error(
          "Provide a judge panel: --judges <ref>,<ref> (S2 needs ≥1, ideally 2+).",
        );
      }
      requireKeys(requiredEnvKeys([model, ...judges]));

      const seeds = Number(opts.seeds);
      if (!Number.isInteger(seeds) || seeds < 1) {
        throw new Error(`--seeds must be a positive integer (got "${opts.seeds}").`);
      }
      const perType = Number(opts.perType);
      const queries = selectQueries(Number.isFinite(perType) ? perType : 0);
      const concurrency = Number(opts.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`--concurrency must be a positive integer (got "${opts.concurrency}").`);
      }
      const arms = queries.length * 2 * seeds;
      process.stdout.write(
        `Credibility run: ${queries.length} queries × 2 providers × ${seeds} seeds ` +
          `= ${arms} arms, each graded by ${judges.length} judge(s), concurrency ${concurrency}.\n` +
          `This is slow + credit-heavy (fresh fetch every seed)…\n\n`,
      );

      const now = Date.now();
      const rows = await runCredibility(queries, { seeds, model, judges, concurrency, now });
      const summary = summarize(rows, {
        seeds,
        answer_model: model,
        judges,
        now,
      });

      process.stdout.write(renderCredibility(summary) + "\n");

      if (opts.save !== false) {
        writeCredibility(rows, summary);
        process.stdout.write(
          `\nsaved → ${S2_RUNS_PATH} (${rows.length} rows) + ${S2_SUMMARY_PATH}\n`,
        );
      }
    });
}

interface CredOptions {
  seeds: string;
  judges?: string;
  model?: string;
  perType: string;
  concurrency: string;
  save?: boolean;
}
