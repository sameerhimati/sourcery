import type { Command } from "commander";
import { listAdapters, missingEnv } from "@core/adapters";
import { cacheStats } from "@core/fetch-cache";
import { loadEnv } from "../env";

// `sourcery providers` — the registry, rendered. Answers the two questions a new
// user actually has: what can I compare, and which of those can I run right now?
export function registerProviders(program: Command): void {
  program
    .command("providers")
    .description("list retrieval providers and whether their keys are set")
    .option("--check", "also probe quota/balance where a provider supports it")
    .action(async (opts: { check?: boolean }) => {
      loadEnv();
      const specs = listAdapters();
      const w = Math.max(...specs.map((s) => s.id.length));

      const lines = await Promise.all(specs.map(async (spec) => {
        const missing = missingEnv(spec.id);
        let status = missing.length ? `needs ${missing.join(", ")}` : "ready";
        // A set key only proves you have a key. --check asks the provider
        // whether it will actually serve a run.
        if (opts.check && !missing.length && spec.health) {
          try {
            status = await spec.health();
          } catch (e) {
            status = `health check failed: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        const mark = missing.length ? "·" : "✓";
        return `  ${mark} ${spec.id.padEnd(w)}  ${spec.label} — ${spec.blurb}\n` +
          `    ${" ".repeat(w)}  ${status}`;
      }));

      const ready = specs.filter((s) => !missingEnv(s.id).length).length;
      // Reported unprompted: a cached fetch is free but 24h stale, and someone
      // reading a scorecard deserves to know which of those they're looking at.
      const { live, expired } = cacheStats();
      const cacheLine = live
        ? `\nFetch cache:      ${live} live (reused free, <24h old)` +
          `${expired ? `, ${expired} expired` : ""} — bypass with --no-cache\n`
        : "";
      process.stdout.write(
        `Retrieval providers (${ready}/${specs.length} ready):\n\n` +
          lines.join("\n") +
          cacheLine +
          `\nCompare any two:  sourcery run "<query>" --values <a>,<b>\n` +
          `Add your own:     see docs/providers.md\n`,
      );
    });
}
