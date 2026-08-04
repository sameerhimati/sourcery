import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { runBatch, selectQueries } from "@core/batch";
import { parseQuerySet, QuerySetError, querySetTemplate } from "@core/query-set";
import { MODEL } from "@core/controls";
import { requiredEnvKeys } from "@core/llm";
import { readCached, setCacheEnabled } from "@core/fetch-cache";
import { defaultProviders, getAdapter } from "@core/adapters";
import { budgetBlock, estimate, renderEstimate } from "@core/preflight";
import { DEFAULT_CONFIG, type Provider } from "@core/types";
import { confirm } from "../prompt";
import { loadEnv, requireKeys } from "../env";
import { loadConfig } from "../config";
import { appendRecords, toBatchRecords, RUNS_PATH } from "../persist";
import { renderBatch } from "../format";
import { createProgress } from "../progress";

export function registerBatch(program: Command): void {
  program
    .command("batch")
    .description("Run the built-in eval set across all providers and summarize")
    .option(
      "--per-type <n>",
      "cap queries per type for a quick pass (0 = full 48-query set)",
      "0",
    )
    .option(
      "--queries <file>",
      "run YOUR queries instead of the built-in set (JSON array or JSONL)",
    )
    .option("--queries-template", "print a starter query file to stdout and exit")
    .option("--model <model>", "answer model override")
    .option("--judge <model>", "judge model (defaults to gpt-4o-mini)")
    .option(
      "--providers <list>",
      "comma-separated provider ids to compare (default: every provider you have keys for)",
    )
    .option("--no-save", "do not append rows to .sourcery/runs.jsonl")
    .option("--no-cache", "always fetch live; ignore fetches cached in the last 24h")
    .option(
      "--max-credits <n>",
      "refuse to start if the run could exceed this many provider credits",
    )
    .option("-y, --yes", "skip the cost confirmation prompt")
    .option("--dry-run", "print the cost estimate and exit without running anything")
    .option("--no-progress", "suppress the progress line")
    .action(async (opts: BatchOptions) => {
      if (opts.queriesTemplate) {
        process.stdout.write(querySetTemplate());
        return;
      }
      loadEnv();
      setCacheEnabled(opts.cache !== false);
      const config = await loadConfig();

      // Validate the provider list FIRST: it's free, local and deterministic, so
      // a typo should be reported as a typo. Checking keys first meant
      // `--providers tavly` on a machine without the LLM key complained about the
      // key, sent you to fix that, and only then admitted the real mistake.
      const providers = opts.providers
        ? opts.providers.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      providers?.forEach((p) => getAdapter(p));
      // Flag, then the provider list `init` wrote to config, then whatever keys
      // are set. `run` already honoured config.values and batch did not, so the
      // arms you configured were respected by one command and silently dropped
      // by the other. Only when the configured axis IS provider: `values` is
      // axis-generic, and a config varying freshness holds "24h"/"all" there.
      const configured =
        (config.variable ?? "provider") === "provider" && config.values?.length
          ? config.values
          : undefined;
      // Resolved once and passed down, so the cost estimate prices exactly the
      // arms the run will execute rather than re-deriving them separately.
      const running = providers ?? configured ?? defaultProviders();

      // Require only the LLM key(s) the chosen answer/judge models need (unset
      // refs fall back to the engine default). Retrieval keys stay optional.
      const model = opts.model ?? config.model;
      const judge = opts.judge ?? config.judge;
      requireKeys(requiredEnvKeys([model ?? MODEL, judge ?? MODEL]), [model ?? MODEL, judge ?? MODEL]);

      const perType = Number(opts.perType);
      // Your own queries are the point of the tool; the built-in 48 are a
      // demonstration that the harness works. --per-type caps the built-in set
      // and has no meaning for a set you wrote yourself, so it is ignored there
      // rather than silently truncating a file you handed us.
      const queries = opts.queries
        ? loadQuerySet(opts.queries)
        : selectQueries(Number.isFinite(perType) ? perType : 0);
      process.stdout.write(
        `Running ${queries.length} queries × ${running.length} providers ` +
          `(${running.join(", ")}) = ${queries.length * running.length} calls ` +
          `— slow + credit-heavy…\n`,
      );

      // Cost BEFORE spending, not after — and count only the arms that will
      // actually hit the network. A cached fetch is free, so quoting the full
      // arm count would refuse runs that cost nothing, which is how a --max-credits
      // ceiling turns from a safety net into an obstacle. (Learned the hard way:
      // a killed run left 21 of 24 fetches cached, and the estimate still asked
      // for the full 120-360.)
      const armsPerProvider = Object.fromEntries(
        running.map((p) => [
          p,
          queries.filter(
            (q) => readCached(p as Provider, q.query, DEFAULT_CONFIG, 0) === null,
          ).length,
        ]),
      );
      const cached = queries.length * running.length -
        Object.values(armsPerProvider).reduce((s, n) => s + n, 0);
      const est = await estimate(running, armsPerProvider, DEFAULT_CONFIG);
      process.stdout.write("\n" + renderEstimate(est) + "\n");
      if (cached) {
        process.stdout.write(
          `  ${cached} of ${queries.length * running.length} calls already cached ` +
            `(<24h old) — those cost nothing. --no-cache to refetch.\n`,
        );
      }

      const block = budgetBlock(est, opts.maxCredits ? Number(opts.maxCredits) : undefined);
      if (block) {
        process.stderr.write(`\n${block}\n`);
        process.exit(1);
      }
      // Costed but not run. The confirmation prompt auto-proceeds when stdin is
      // not a TTY (so pipes and CI don't hang), which means there was otherwise
      // no way to ask "what would this cost?" without risking spending it.
      if (opts.dryRun) {
        process.stdout.write("\n--dry-run: nothing spent, nothing run.\n");
        return;
      }
      if (est.overBalance.length) {
        process.stderr.write(
          `\n⚠ ${est.overBalance.join(", ")} may run out mid-run — the calls that ` +
            `land after that will 402 and score as failures, not as low scores.\n`,
        );
      }
      if (!opts.yes && est.totalMax > 0 && !(await confirm("\nProceed?"))) {
        process.stdout.write("Aborted — nothing spent.\n");
        return;
      }

      // The one place progress is not a nicety: this is 48 × providers arms at
      // concurrency 4, which is minutes to an hour of otherwise total silence.
      const progress = createProgress({
        tty: Boolean(process.stdout.isTTY) && opts.progress !== false,
        write: (s) => process.stdout.write(s),
        width: process.stdout.columns ?? 100,
      });
      process.stdout.write("\n");
      let out;
      try {
        out = await runBatch(queries, undefined, {
          model,
          judgeModel: judge,
          providers: running,
          onProgress: (e) => progress.update(e),
        });
      } finally {
        progress.stop();
      }
      process.stdout.write("\n" + renderBatch(out) + "\n");

      if (opts.save !== false) {
        const batchId = `batch_${Date.now().toString(36)}`;
        appendRecords(toBatchRecords(out, batchId));
        process.stdout.write(
          `\nsaved → ${RUNS_PATH} (${out.rows.length} rows, ${batchId})\n`,
        );
      }
    });
}

interface BatchOptions {
  perType: string;
  model?: string;
  judge?: string;
  providers?: string;
  save?: boolean;
  cache?: boolean;
  maxCredits?: string;
  yes?: boolean;
  dryRun?: boolean;
  progress?: boolean;
  queries?: string;
  queriesTemplate?: boolean;
}

/**
 * Read a user query set, and fail with something actionable.
 *
 * A malformed query file is the most likely thing to go wrong on someone's first
 * real use of this tool, so the error has to name the file, the entry and the
 * fix — not surface a JSON.parse stack trace from three frames down.
 */
function loadQuerySet(file: string): ReturnType<typeof parseQuerySet> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`Cannot read ${file}\n  \`sourcery batch --queries-template\` prints a starting point.\n`);
    process.exit(1);
  }
  try {
    return parseQuerySet(text, file);
  } catch (e) {
    if (e instanceof QuerySetError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
