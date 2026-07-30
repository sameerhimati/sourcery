import type { Command } from "commander";
import { runBatch, selectQueries } from "@core/batch";
import { MODEL } from "@core/controls";
import { requiredEnvKeys } from "@core/llm";
import { readCached, setCacheEnabled } from "@core/fetch-cache";
import { DEFAULT_PROVIDERS, getAdapter } from "@core/adapters";
import { budgetBlock, estimate, renderEstimate } from "@core/preflight";
import { DEFAULT_CONFIG, type Provider } from "@core/types";
import { confirm } from "../prompt";
import { loadEnv, requireKeys } from "../env";
import { loadConfig } from "../config";
import { appendRecords, toBatchRecords, RUNS_PATH } from "../persist";
import { renderBatch } from "../format";

export function registerBatch(program: Command): void {
  program
    .command("batch")
    .description("Run the built-in eval set across all providers and summarize")
    .option(
      "--per-type <n>",
      "cap queries per type for a quick pass (0 = full 48-query set)",
      "0",
    )
    .option("--model <model>", "answer model override")
    .option("--judge <model>", "judge model (defaults to gpt-4o-mini)")
    .option(
      "--providers <list>",
      "comma-separated provider ids to compare (default: bright_data,firecrawl)",
    )
    .option("--no-save", "do not append rows to .sourcery/runs.jsonl")
    .option("--no-cache", "always fetch live; ignore fetches cached in the last 24h")
    .option(
      "--max-credits <n>",
      "refuse to start if the run could exceed this many provider credits",
    )
    .option("-y, --yes", "skip the cost confirmation prompt")
    .option("--dry-run", "print the cost estimate and exit without running anything")
    .action(async (opts: BatchOptions) => {
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
      const running = providers ?? DEFAULT_PROVIDERS;

      // Require only the LLM key(s) the chosen answer/judge models need (unset
      // refs fall back to the engine default). Retrieval keys stay optional.
      const model = opts.model ?? config.model;
      const judge = opts.judge ?? config.judge;
      requireKeys(requiredEnvKeys([model ?? MODEL, judge ?? MODEL]), [model ?? MODEL, judge ?? MODEL]);

      const perType = Number(opts.perType);
      const queries = selectQueries(Number.isFinite(perType) ? perType : 0);
      process.stdout.write(
        `Running ${queries.length} queries × ${running.length} providers ` +
          `(${running.join(", ")}) = ${queries.length * running.length} arms ` +
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
          `  ${cached} of ${queries.length * running.length} arms already cached ` +
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
          `\n⚠ ${est.overBalance.join(", ")} may run out mid-run — the arms that ` +
            `land after that will 402 and score as failures, not as low scores.\n`,
        );
      }
      if (!opts.yes && est.totalMax > 0 && !(await confirm("\nProceed?"))) {
        process.stdout.write("Aborted — nothing spent.\n");
        return;
      }

      const out = await runBatch(queries, undefined, {
        model,
        judgeModel: judge,
        ...(providers ? { providers } : {}),
      });
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
}
