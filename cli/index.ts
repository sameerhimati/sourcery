#!/usr/bin/env node
import { Command } from "commander";
import { registerRun } from "./commands/run";

const program = new Command();

program
  .name("sourcery")
  .description("Eval your web-retrieval layer on your own queries")
  .version("0.1.0");

registerRun(program);

program.parseAsync().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
