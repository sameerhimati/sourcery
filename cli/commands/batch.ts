import type { Command } from "commander";
import { runBatch, selectQueries } from "@core/batch";
import { MODEL } from "@core/controls";
import { requiredEnvKeys } from "@core/llm";
import { setCacheEnabled } from "@core/fetch-cache";
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
    .option("--no-save", "do not append rows to .sourcery/runs.jsonl")
    .option("--no-cache", "always fetch live; ignore fetches cached in the last 24h")
    .action(async (opts: BatchOptions) => {
      loadEnv();
      setCacheEnabled(opts.cache !== false);
      const config = await loadConfig();

      // Require only the LLM key(s) the chosen answer/judge models need (unset
      // refs fall back to the engine default). Retrieval keys stay optional.
      const model = opts.model ?? config.model;
      const judge = opts.judge ?? config.judge;
      requireKeys(requiredEnvKeys([model ?? MODEL, judge ?? MODEL]), [model ?? MODEL, judge ?? MODEL]);

      const perType = Number(opts.perType);
      const queries = selectQueries(Number.isFinite(perType) ? perType : 0);
      process.stdout.write(
        `Running ${queries.length} queries × 2 providers (this is slow + credit-heavy)…\n`,
      );

      const out = await runBatch(queries, undefined, {
        model,
        judgeModel: judge,
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
  save?: boolean;
  cache?: boolean;
}
