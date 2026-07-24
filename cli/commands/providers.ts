import type { Command } from "commander";
import { listAdapters, missingEnv } from "@core/adapters";
import { loadEnv } from "../env";

// `sourcery providers` — the registry, rendered. Answers the two questions a new
// user actually has: what can I compare, and which of those can I run right now?
export function registerProviders(program: Command): void {
  program
    .command("providers")
    .description("list retrieval providers and whether their keys are set")
    .action(() => {
      loadEnv();
      const specs = listAdapters();
      const w = Math.max(...specs.map((s) => s.id.length));

      const lines = specs.map((spec) => {
        const missing = missingEnv(spec.id);
        const status = missing.length ? `needs ${missing.join(", ")}` : "ready";
        const mark = missing.length ? "·" : "✓";
        return `  ${mark} ${spec.id.padEnd(w)}  ${spec.label} — ${spec.blurb}\n` +
          `    ${" ".repeat(w)}  ${status}`;
      });

      const ready = specs.filter((s) => !missingEnv(s.id).length).length;
      process.stdout.write(
        `Retrieval providers (${ready}/${specs.length} ready):\n\n` +
          lines.join("\n") +
          `\n\nCompare any two:  sourcery run "<query>" --values <a>,<b>\n` +
          `Add your own:     see docs/providers.md\n`,
      );
    });
}
