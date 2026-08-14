import type { Command } from "commander";
import { isTransportFailure, resumableKeys, runCredibility, summarize, armKey } from "@core/credibility";
import { selectQueries } from "@core/batch";
import { getAdapter, defaultProviders } from "@core/adapters";
import { MODEL } from "@core/controls";
import { requiredEnvKeys } from "@core/llm";
import { setCacheEnabled } from "@core/fetch-cache";
import { budgetBlock, estimate, renderEstimate } from "@core/preflight";
import { DEFAULT_CONFIG, type Provider } from "@core/types";
import { confirm } from "../prompt";
import { loadEnv, requireKeys } from "../env";
import { loadConfig } from "../config";
import {
  appendCredibilityRow,
  readCredibilityRows,
  writeCredibilitySummary,
  S2_RUNS_PATH,
  S2_SUMMARY_PATH,
} from "../persist";
import { renderCredibility } from "../format";
import { loadQuerySet } from "../query-file";

// S2 credibility run: the full 48 × seeds × 2 providers matrix graded by a JUDGE
// PANEL, producing confidence intervals + inter-judge agreement. Separate from
// `batch` (which is single-judge, single-seed) so the live/dashboard path stays
// untouched. Slow + credit-heavy — start with --per-type for a dry run.
export function registerCredibility(program: Command): void {
  program
    // Hidden, not removed: this is the research instrument that produced the
    // published finding, and the only way to regenerate docs/s2-summary.json.
    // But it's a 480-arm, credit-heavy run that nobody should meet while
    // learning the tool, and the panel/CI vocabulary it introduces belongs in
    // the docs rather than in `--help`.
    .command("credibility", { hidden: true })
    .description("S2: queries × providers × seeds, judge panel → CIs + judge agreement")
    .option("--seeds <n>", "fresh-fetch repeats per (query × provider)", "5")
    .option("--judges <list>", "comma-separated judge model refs (the panel)")
    .option("--model <model>", "answer model (held constant across results)")
    .option("--per-type <n>", "cap queries per type for a dry run (0 = full 48)", "0")
    .option("--queries <file>", "measure a query set of your own instead of the built-in 48")
    .option("--concurrency <n>", "pipelines in flight (higher = faster, more load)", "4")
    .option("--providers <list>", "comma-separated provider ids to compare")
    .option("--resume", "skip results already in .sourcery/s2-runs.jsonl")
    .option("--fail-fast <n>", "abort if a provider's first n results all fail (0 = off)", "8")
    .option("--no-save", "do not write .sourcery/s2-*.{jsonl,json}")
    .option("--no-cache", "always fetch live; ignore fetches cached in the last 24h")
    .option(
      "--max-credits <n>",
      "refuse to start if the run could exceed this many provider credits",
    )
    .option("-y, --yes", "skip the cost confirmation prompt")
    .option("--dry-run", "print the cost estimate and exit without running anything")
    .action(async (opts: CredOptions) => {
      loadEnv();
      setCacheEnabled(opts.cache !== false);
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
      requireKeys(requiredEnvKeys([model, ...judges]), [model, ...judges]);

      const seeds = Number(opts.seeds);
      if (!Number.isInteger(seeds) || seeds < 1) {
        throw new Error(`--seeds must be a positive integer (got "${opts.seeds}").`);
      }
      // --queries is what makes a second dataset measurable the way the built-in
      // 48 were: same seeds, same judge panel, same CIs, same stage attribution.
      // `batch --queries` already existed, but batch is single-seed, single-judge
      // and has no --resume, so anything run through it can't be compared to the
      // published table. --per-type only slices the built-in set, so the two
      // flags are mutually exclusive rather than composed.
      const perType = Number(opts.perType);
      if (opts.queries && perType > 0) {
        throw new Error("--per-type slices the built-in 48; it does nothing to --queries. Trim the file instead.");
      }
      const queries = opts.queries
        ? loadQuerySet(opts.queries)
        : selectQueries(Number.isFinite(perType) ? perType : 0);
      const concurrency = Number(opts.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`--concurrency must be a positive integer (got "${opts.concurrency}").`);
      }
      const providers = (opts.providers ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Validate up front: a typo'd id should fail now, not 200 arms in.
      for (const p of providers) getAdapter(p);
      const armSet = providers.length ? providers : defaultProviders();
      const arms = queries.length * armSet.length * seeds;
      // --resume replays what's already on disk so a killed run costs minutes,
      // not hours. Rows are appended as they land, so this always has a floor.
      const prior = opts.resume ? readCredibilityRows() : [];
      // Skip what's on disk — EXCEPT results that failed because this machine
      // lost the network. Those are not measurements of anything; skipping them
      // would publish your own outage as a provider's failure rate, and the
      // failure rate is the headline reliability claim.
      const done = resumableKeys(prior);
      // Only the part of THIS run's matrix that's already covered. The log also
      // holds every earlier run's rows — counting those said "550 already on
      // disk, -70 to go" for a 480-result matrix, which reads like a bug in the
      // arithmetic and undermines the number next to it.
      const inMatrix = queries.flatMap((q) =>
        armSet.flatMap((p) =>
          Array.from({ length: seeds }, (_, seed) => armKey(q.id, p as Provider, seed)),
        ),
      );
      const alreadyDone = inMatrix.filter((k) => done.has(k)).length;
      const retrying = prior.filter(
        (r) => isTransportFailure(r.error) && armSet.includes(r.provider),
      ).length;
      process.stdout.write(
        `Credibility run: ${queries.length} queries × ${armSet.join("/")} × ${seeds} seeds ` +
          `= ${arms} results, each graded by ${judges.length} judge(s), concurrency ${concurrency}.\n` +
          (alreadyDone ? `Resuming: ${alreadyDone} of those already on disk, ${arms - alreadyDone} to go.\n` : "") +
          (retrying
            ? `Retrying ${retrying} that failed with a network error — those measure your ` +
              `connection, not the provider.\n`
            : "") +
          `This is slow + credit-heavy (fresh fetch every seed)…\n\n`,
      );

      // This is the run that consumed a 5000/mo Firecrawl plan without warning,
      // so it is the one that most needs a number up front. Count arms PER
      // PROVIDER and net off anything --resume will replay from disk for free.
      const remainingPerProvider = Object.fromEntries(
        armSet.map((p) => [
          p,
          queries.length * seeds -
            queries.reduce(
              (n, q) =>
                n +
                Array.from({ length: seeds }, (_, s) => s).filter((s) =>
                  done.has(armKey(q.id, p as Provider, s)),
                ).length,
              0,
            ),
        ]),
      );
      const est = await estimate(armSet, remainingPerProvider, DEFAULT_CONFIG);
      process.stdout.write(renderEstimate(est) + "\n");

      const block = budgetBlock(est, opts.maxCredits ? Number(opts.maxCredits) : undefined);
      if (block) {
        process.stderr.write(`\n${block}\n`);
        process.exit(1);
      }
      if (opts.dryRun) {
        process.stdout.write("\n--dry-run: nothing spent, nothing run.\n");
        return;
      }
      if (est.overBalance.length) {
        process.stderr.write(
          `\n⚠ ${est.overBalance.join(", ")} may run out mid-run. --fail-fast catches a\n` +
            `  provider that is dead on arrival, but not one that dies halfway.\n`,
        );
      }
      if (!opts.yes && est.totalMax > 0 && !(await confirm("\nProceed?"))) {
        process.stdout.write("Aborted — nothing spent.\n");
        return;
      }
      process.stdout.write("\n");

      const now = Date.now();
      const save = opts.save !== false;
      const fresh = await runCredibility(queries, {
        seeds, model, judges, concurrency, now, done, providers: armSet,
        failFast: Number(opts.failFast) || 0,
        onRow: (row, landed, total) => {
          if (save) appendCredibilityRow(row);
          process.stdout.write(
            `[${String(landed).padStart(String(total).length)}/${total}] ` +
              `${row.provider} ${row.queryId} seed${row.seed} ` +
              `${row.error ? `ERROR ${row.error.slice(0, 60)}` : `${row.num_sources} src ${(row.latency_ms / 1000).toFixed(1)}s`}\n`,
          );
        },
      });

      const rows = [...prior, ...fresh];
      const summary = summarize(rows, {
        seeds,
        answer_model: model,
        judges,
        now,
      });

      process.stdout.write("\n" + renderCredibility(summary) + "\n");

      if (save) {
        writeCredibilitySummary(summary);
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
  queries?: string;
  concurrency: string;
  providers?: string;
  resume?: boolean;
  failFast: string;
  save?: boolean;
  cache?: boolean;
  maxCredits?: string;
  yes?: boolean;
  dryRun?: boolean;
}
