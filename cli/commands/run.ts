import type { Command } from "commander";
import { runEval } from "@core/orchestrator";
import type { Axis, RunRequest } from "@core/types";
import { loadEnv, requireKeys } from "../env";
import { loadConfig } from "../config";
import { appendRun, toRecord, RUNS_PATH } from "../persist";
import { renderRun } from "../format";

export function registerRun(program: Command): void {
  program
    .command("run")
    .argument("<query>", "the query to evaluate")
    .description("Evaluate one query across all arms and print a scorecard")
    .option(
      "--variable <axis>",
      "axis to vary: provider | freshness | num_sources | extraction",
    )
    .option("--values <list>", "comma-separated values for the varied axis")
    .option("--model <model>", "answer/judge model override")
    .option("--no-save", "do not append the run to .sourcery/runs.jsonl")
    .action(async (query: string, opts: RunOptions) => {
      loadEnv();
      // Only OPENAI_API_KEY is hard-required; provider keys degrade into a
      // per-arm error, which the scorecard shows rather than crashing on.
      requireKeys(["OPENAI_API_KEY"]);

      // Precedence: CLI flag > sourcery.config > engine default.
      const config = await loadConfig();
      const values = opts.values
        ? opts.values.split(",").map((s) => s.trim()).filter(Boolean)
        : config.values;

      const req: RunRequest = {
        query,
        variable: (opts.variable ?? config.variable ?? "provider") as Axis,
        ...(values ? { values } : {}),
        ...(opts.model ?? config.model ? { model: opts.model ?? config.model } : {}),
      };

      const run = await runEval(req);
      process.stdout.write(renderRun(run) + "\n");

      if (opts.save !== false) {
        const ts = new Date().toISOString();
        const id = `run_${Date.now().toString(36)}`;
        appendRun(toRecord(run, id, ts));
        process.stdout.write(`\nsaved → ${RUNS_PATH} (${id})\n`);
      }
    });
}

interface RunOptions {
  variable: string;
  values?: string;
  model?: string;
  save?: boolean;
}
