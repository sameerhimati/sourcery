import type { Command } from "commander";
import {
  dedupeFetchRows,
  fetchKey,
  poolFromFetchRows,
  resumableFetchKeys,
  resumableJudgementKeys,
  resumableSetVerdictKeys,
  runPooledFetch,
  runPooledJudging,
  runSetJudging,
  summarizePooled,
  type PooledFetchRow,
  type PooledSetVerdictRow,
} from "@core/pooled";
import {
  resumableNoSearchKeys,
  runNoSearchBaseline,
  summarizeNoSearch,
} from "@core/noSearch";
import { pairKey } from "@core/pool";
import { judgeLabel } from "@core/credibility";
import { selectQueries } from "@core/batch";
import { getAdapter, defaultProviders } from "@core/adapters";
import { requiredEnvKeys } from "@core/llm";
import { setCacheEnabled } from "@core/fetch-cache";
import { budgetBlock, estimate, renderEstimate } from "@core/preflight";
import { DEFAULT_CONFIG, type Provider } from "@core/types";
import { confirm } from "../prompt";
import { loadEnv, requireKeys } from "../env";
import {
  appendNoSearchRow,
  appendPooledFetch,
  appendPooledJudgement,
  appendPooledSetVerdict,
  readNoSearchRows,
  readPooledFetches,
  readPooledJudgements,
  readPooledSetVerdicts,
  writeNoSearchSummary,
  writePooledSummary,
  NO_SEARCH_PATH,
  NO_SEARCH_SUMMARY_PATH,
  POOLED_FETCHES_PATH,
  POOLED_JUDGEMENTS_PATH,
  POOLED_SET_VERDICTS_PATH,
  POOLED_SUMMARY_PATH,
} from "../persist";
import { renderNoSearch, renderPooled } from "../format";
import { loadQuerySet } from "../query-file";

// Run 2: the pooled run — the instrument docs/preregistration-v3.md commits to.
// Fetch every (query × provider) once, pool every returned page, judge each
// unique question-page pair once per panel judge (blind by construction), then
// score providers against the pooled verdicts. Hidden for the same reason
// `credibility` is: a research instrument, not the front door.
export function registerPooled(program: Command): void {
  program
    .command("pooled", { hidden: true })
    .description("Run 2: pool pages across providers, judge each pair once, score against the pool")
    .option("--judges <list>", "comma-separated judge model refs (the panel; the method calls for five, from five labs)")
    .option("--queries <file>", "measure a query set of your own instead of the built-in 48")
    .option("--per-type <n>", "cap built-in queries per type for a dry run (0 = full 48)", "0")
    .option("--providers <list>", "comma-separated provider ids to compare")
    .option("--concurrency <n>", "pipelines in flight", "4")
    .option("--resume", "skip fetches/judgements already in .sourcery/pooled-*.jsonl")
    .option("--fetch-only", "stop after the fetch phase (spends provider credits, no judging)")
    .option("--judge-only", "skip fetching; pool and judge what is already on disk")
    .option("--set-judge", "also grade each provider's whole returned set 0–10, not just page by page")
    .option("--batch", "submit judging through the providers' batch APIs at half price (async; falls back to synchronous where unsupported)")
    // Not "--no-search-only": Commander reads a --no- prefix as negating
    // --search-only, and would quietly set searchOnly=false instead.
    .option("--baseline-only", "run only the no-search baseline — answer every question with zero sources, grade it, then stop")
    .option("--baseline-model <ref>", "the model that answers with no sources (default: the run's answer model)")
    .option("--fail-fast <n>", "abort if a provider's first n fetches all fail (0 = off)", "8")
    .option("--no-save", "do not write .sourcery/pooled-*")
    .option("--no-cache", "always fetch live; ignore fetches cached in the last 24h")
    .option("--max-credits <n>", "refuse to start if the fetch phase could exceed this many credits")
    .option("-y, --yes", "skip the cost confirmation prompt")
    .option("--dry-run", "print the cost estimate and exit without running anything")
    .action(async (opts: PooledOptions) => {
      loadEnv();
      setCacheEnabled(opts.cache !== false);

      const judges = (opts.judges ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!opts.fetchOnly && judges.length < 1) {
        throw new Error("Provide a judge panel: --judges <ref>,<ref>,… (or --fetch-only to defer judging).");
      }
      if (judges.length > 0 && judges.length < 3) {
        process.stderr.write(
          `⚠ ${judges.length} judge(s). The method calls for five, from five different labs —\n` +
            `  judges only cancel each other's blind spots if the blind spots differ.\n\n`,
        );
      }
      if (judges.length) requireKeys(requiredEnvKeys(judges), judges);

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
      const named = (opts.providers ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of named) getAdapter(p);
      const providers = named.length ? named : defaultProviders();
      const save = opts.save !== false;

      // ── the no-search baseline ──
      // Runs before anything is fetched and stops there: it needs no provider
      // key and no credits, so it is the one phase that can run while the rest
      // of the matrix is still blocked. Its output is a property of the
      // questions, reusable by any run over the same set.
      if (opts.baselineOnly) {
        const baselineModel = opts.baselineModel;
        const priorRows = opts.resume ? readNoSearchRows() : [];
        const fresh = await runNoSearchBaseline(queries, judges, {
          concurrency,
          ...(baselineModel ? { model: baselineModel } : {}),
          done: resumableNoSearchKeys(priorRows),
          onRow: (row, landed, total) => {
            if (save) appendNoSearchRow(row);
            process.stdout.write(
              `[baseline ${String(landed).padStart(String(total).length)}/${total}] ` +
                `${row.grader} ${row.queryId} ` +
                `${row.error ? `ERROR ${row.error.slice(0, 40)}` : (row.verdict ?? "no verdict")}\n`,
            );
          },
        });
        const rows = [...priorRows, ...fresh].filter((r) => queries.some((q) => q.id === r.queryId));
        const summary = summarizeNoSearch(rows, {
          model: baselineModel ?? rows[0]?.model ?? "",
          graders: judges.map(judgeLabel),
        });
        process.stdout.write("\n" + renderNoSearch(summary) + "\n");
        if (save) {
          writeNoSearchSummary(summary);
          process.stdout.write(`\nsaved → ${NO_SEARCH_PATH} + ${NO_SEARCH_SUMMARY_PATH}\n`);
        }
        return;
      }

      const queryIds = new Set(queries.map((q) => q.id));
      const inMatrix = (r: PooledFetchRow): boolean =>
        queryIds.has(r.queryId) && providers.includes(r.provider);

      // ── phase 1: fetch ──
      const prior = opts.resume || opts.judgeOnly ? readPooledFetches() : [];
      let fetchRows: PooledFetchRow[];
      if (opts.judgeOnly) {
        fetchRows = dedupeFetchRows(prior).filter(inMatrix);
        if (!fetchRows.length) {
          throw new Error(
            `--judge-only, but ${POOLED_FETCHES_PATH} holds no fetches for this matrix. Run the fetch phase first.`,
          );
        }
        process.stdout.write(`Judging from disk: ${fetchRows.length} fetches already landed.\n\n`);
      } else {
        const done = resumableFetchKeys(prior);
        const total = queries.length * providers.length;
        const remaining = queries.flatMap((q) =>
          providers.filter((p) => !done.has(fetchKey(q.id, p as Provider))).map((p) => p),
        );
        process.stdout.write(
          `Pooled run: ${queries.length} queries × ${providers.join("/")} = ${total} fetches` +
            (total - remaining.length ? ` (${total - remaining.length} already on disk)` : "") +
            `, one per pair — repeats measured seed noise in run 1; run 2 spends on breadth.\n\n`,
        );
        const remainingPerProvider = Object.fromEntries(
          providers.map((p) => [p, remaining.filter((r) => r === p).length]),
        );
        const est = await estimate(providers, remainingPerProvider, DEFAULT_CONFIG);
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
        if (!opts.yes && est.totalMax > 0 && !(await confirm("\nProceed?"))) {
          process.stdout.write("Aborted — nothing spent.\n");
          return;
        }
        process.stdout.write("\n");

        const fresh = await runPooledFetch(queries, providers as Provider[], {
          concurrency,
          done,
          failFast: Number(opts.failFast) || 0,
          onRow: (row, landed, totalJobs) => {
            if (save) appendPooledFetch(row);
            process.stdout.write(
              `[fetch ${String(landed).padStart(String(totalJobs).length)}/${totalJobs}] ` +
                `${row.provider} ${row.queryId} ` +
                `${row.error ? `ERROR ${row.error.slice(0, 60)}` : `${row.num_sources} src ${((row.fetch_ms ?? 0) / 1000).toFixed(1)}s`}\n`,
            );
          },
        });
        fetchRows = dedupeFetchRows([...prior, ...fresh]).filter(inMatrix);
      }

      // ── phase 2: pool + judge ──
      const pool = poolFromFetchRows(fetchRows);
      process.stdout.write(
        `\nPooled: ${pool.length} unique question-page pairs across ${fetchRows.length} fetches. ` +
          `Each pair is judged once per judge; the verdict is reused for every provider that returned it.\n`,
      );
      if (opts.fetchOnly) {
        process.stdout.write(`--fetch-only: stopping here. Judge later with --judge-only --resume.\n`);
        return;
      }

      const priorJudgements = opts.resume || opts.judgeOnly ? readPooledJudgements() : [];
      const judged = resumableJudgementKeys(priorJudgements);
      const fresh = await runPooledJudging(pool, judges, {
        concurrency,
        done: judged,
        batch: opts.batch,
        onProgress: (s) => process.stdout.write(`  ${s}\n`),
        onRow: (row, landed, total) => {
          if (save) appendPooledJudgement(row);
          process.stdout.write(
            `[judge ${String(landed).padStart(String(total).length)}/${total}] ` +
              `${row.judge} ${row.queryId} ${row.url.slice(0, 50)} ` +
              `${row.error ? `ERROR ${row.error.slice(0, 40)}` : `rung ${row.rung ?? "none"}`}\n`,
          );
        },
      });

      // Only this matrix's pairs — the log may hold judgements from other
      // datasets, and agreement/distribution must not mix instruments.
      const poolKeys = new Set(pool.map((p) => pairKey(p.queryId, p.url)));
      const judgements = [...priorJudgements, ...fresh].filter((j) =>
        poolKeys.has(pairKey(j.queryId, j.url)),
      );

      // ── phase 2b: grade each returned set as a whole ──
      let setVerdicts: PooledSetVerdictRow[] = [];
      if (opts.setJudge) {
        const priorSets = opts.resume || opts.judgeOnly ? readPooledSetVerdicts() : [];
        const freshSets = await runSetJudging(fetchRows, judges, {
          concurrency,
          done: resumableSetVerdictKeys(priorSets),
          batch: opts.batch,
          onProgress: (s) => process.stdout.write(`  ${s}\n`),
          onRow: (row, landed, total) => {
            if (save) appendPooledSetVerdict(row);
            process.stdout.write(
              `[set ${String(landed).padStart(String(total).length)}/${total}] ` +
                `${row.judge} ${row.queryId} ${row.provider} ` +
                `${row.error ? `ERROR ${row.error.slice(0, 40)}` : `score ${row.score ?? "none"}`}\n`,
            );
          },
        });
        // Only this matrix's rows, for the same reason the pair judgements are
        // filtered: the log may hold verdicts from another question set.
        const rowKeys = new Set(fetchRows.map((r) => fetchKey(r.queryId, r.provider)));
        setVerdicts = [...priorSets, ...freshSets].filter((v) =>
          rowKeys.has(fetchKey(v.queryId, v.provider)),
        );
      }

      // ── phase 3: score ──
      const summary = summarizePooled(fetchRows, judgements, {
        judges,
        now: Date.now(),
        setVerdicts,
      });
      process.stdout.write("\n" + renderPooled(summary) + "\n");
      if (save) {
        writePooledSummary(summary);
        process.stdout.write(
          `\nsaved → ${POOLED_FETCHES_PATH} + ${POOLED_JUDGEMENTS_PATH}` +
            (opts.setJudge ? ` + ${POOLED_SET_VERDICTS_PATH}` : "") +
            ` + ${POOLED_SUMMARY_PATH}\n`,
        );
      }
    });
}

interface PooledOptions {
  judges?: string;
  queries?: string;
  perType: string;
  providers?: string;
  concurrency: string;
  resume?: boolean;
  fetchOnly?: boolean;
  judgeOnly?: boolean;
  setJudge?: boolean;
  batch?: boolean;
  baselineOnly?: boolean;
  baselineModel?: string;
  failFast: string;
  save?: boolean;
  cache?: boolean;
  maxCredits?: string;
  yes?: boolean;
  dryRun?: boolean;
}
