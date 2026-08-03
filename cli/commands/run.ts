import type { Command } from "commander";
import { runEval } from "@core/orchestrator";
import type { Axis, RunRequest } from "@core/types";
import { MODEL } from "@core/controls";
import { requiredEnvKeys } from "@core/llm";
import { getAdapter } from "@core/adapters";
import { setCacheEnabled } from "@core/fetch-cache";
import { loadEnv, requireKeys } from "../env";
import { loadConfig } from "../config";
import { appendRecords, toRunRecord, RUNS_PATH } from "../persist";
import { renderRun } from "../format";

export function registerRun(program: Command): void {
  program
    .command("run")
    .argument("<query>", "the query to evaluate")
    .description("Evaluate one query across every provider and print a scorecard")
    .option(
      "--variable <axis>",
      "axis to vary: provider | freshness | num_sources | extraction",
    )
    .option("--values <list>", "comma-separated values for the varied axis")
    .option("--model <model>", "answer model override")
    .option(
      "--judge <model>",
      "judge model (grades retrieval + answer); defaults to gpt-4o-mini",
    )
    .option("--no-save", "do not append the run to .sourcery/runs.jsonl")
    .option("--no-cache", "always fetch live; ignore fetches cached in the last 24h")
    .action(async (query: string, opts: RunOptions) => {
      loadEnv();
      setCacheEnabled(opts.cache !== false);

      // Precedence: CLI flag > sourcery.config > engine default.
      const config = await loadConfig();
      const values = opts.values
        ? opts.values.split(",").map((s) => s.trim()).filter(Boolean)
        : config.values;

      // A mistyped provider should be a startup error naming the valid ids, not
      // N identical per-arm failures the user has to read a scorecard to find.
      const variable = (opts.variable ?? config.variable ?? "provider") as Axis;
      if (variable === "provider" && values) values.forEach((v) => getAdapter(v));

      const model = opts.model ?? config.model;
      const judge = opts.judge ?? config.judge;

      // Require only the LLM key(s) the chosen answer/judge models actually
      // need — a Fireworks-only run must not demand OPENAI_API_KEY. Unset refs
      // fall back to the engine default (MODEL). Retrieval-provider keys stay
      // optional: a missing one degrades into a per-arm error, not a crash.
      requireKeys(requiredEnvKeys([model ?? MODEL, judge ?? MODEL]), [model ?? MODEL, judge ?? MODEL]);
      const req: RunRequest = {
        query,
        variable,
        ...(values ? { values } : {}),
        ...(model ? { model } : {}),
        ...(judge ? { judge_model: judge } : {}),
      };

      const run = await runEval(req);
      process.stdout.write(renderRun(run) + "\n");

      if (opts.save !== false) {
        const ts = new Date().toISOString();
        const id = `run_${Date.now().toString(36)}`;
        appendRecords([toRunRecord(run, id, ts)]);
        process.stdout.write(`\nsaved → ${RUNS_PATH} (${id})\n`);
      }
    });
}

interface RunOptions {
  variable?: string;
  values?: string;
  model?: string;
  judge?: string;
  save?: boolean;
  cache?: boolean;
}
