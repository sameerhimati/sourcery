import type { Command } from "commander";
import { runBatch, selectQueries } from "@core/batch";
import { loadEnv, requireKeys } from "../env";
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
    .option("--no-save", "do not append rows to .sourcery/runs.jsonl")
    .action(async (opts: BatchOptions) => {
      loadEnv();
      requireKeys(["OPENAI_API_KEY"]);

      const perType = Number(opts.perType);
      const queries = selectQueries(Number.isFinite(perType) ? perType : 0);
      process.stdout.write(
        `Running ${queries.length} queries × 2 providers (this is slow + credit-heavy)…\n`,
      );

      const out = await runBatch(queries);
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
  save?: boolean;
}
