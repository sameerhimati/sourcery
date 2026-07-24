import type { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { loadEnv } from "../env";
import { CONFIG_FILES } from "../config";

const CONFIG_TEMPLATE = `// sourcery config — plain ES module, edit freely.
// CLI flags override these; these override the engine's built-in defaults.
export default {
  // Answer + judge model. A "provider/model" ref picks the backend; a bare id
  // (e.g. "gpt-4o-mini") means OpenAI. Both use the same OpenAI-compatible API.
  model: "fireworks/accounts/fireworks/models/kimi-k2p6",
  // Judge grades retrieval + answer. deepseek-v4-pro (temp 0, JSON) here.
  // Note: the anti-cheat ideally wants a judge whose cutoff predates the
  // queries — a fresh judge degrades only answer_score; retrieval_score (the
  // primary metric) is cutoff-independent. Swap in a stale model if you have one.
  judge: "fireworks/accounts/fireworks/models/deepseek-v4-pro",
  // Default comparison for \`sourcery run\`: vary the retrieval provider.
  variable: "provider",
  values: ["bright_data", "firecrawl"],
};
`;

const ENV_TEMPLATE = `# Copy to .env.local and fill in. sourcery reads these via process.env.
# You need ONE LLM key — whichever provider your answer/judge models use.
# OPENAI_API_KEY (default models) or FIREWORKS_API_KEY (fireworks/* models).
# Missing a retrieval-provider key just makes that provider's arm fail gracefully.

# LLM (answer + both judges) — set the one matching your chosen models.
OPENAI_API_KEY=
FIREWORKS_API_KEY=

BRIGHTDATA_API_TOKEN=
BRIGHTDATA_SERP_ZONE=sourcery_serp
BRIGHTDATA_UNLOCKER_ZONE=

FIRECRAWL_API_KEY=
`;

// One LLM key is required, but which one depends on the chosen models, so both
// are listed as optional here and the run command enforces the right one.
const KEYS: { name: string; required: boolean }[] = [
  { name: "OPENAI_API_KEY", required: false },
  { name: "FIREWORKS_API_KEY", required: false },
  { name: "BRIGHTDATA_API_TOKEN", required: false },
  { name: "BRIGHTDATA_SERP_ZONE", required: false },
  { name: "BRIGHTDATA_UNLOCKER_ZONE", required: false },
  { name: "FIRECRAWL_API_KEY", required: false },
];

/** Write `file` only if absent; report which happened. */
function scaffold(file: string, contents: string): string {
  if (existsSync(file)) return `  · ${file} already exists — left as is`;
  writeFileSync(file, contents);
  return `  ✓ wrote ${file}`;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Scaffold sourcery.config.mjs + .env.example and detect keys")
    .action(() => {
      const out: string[] = ["Scaffolding sourcery:"];
      out.push(scaffold(CONFIG_FILES[0], CONFIG_TEMPLATE));
      out.push(scaffold(".env.example", ENV_TEMPLATE));

      loadEnv();
      out.push("", "Keys detected:");
      for (const { name, required } of KEYS) {
        const set = Boolean(process.env[name]?.trim());
        const tag = set ? "✓" : required ? "✗ (required)" : "· (optional)";
        out.push(`  ${tag} ${name}`);
      }

      out.push(
        "",
        "Next: fill .env.local, then `sourcery run \"<your query>\"`.",
      );
      process.stdout.write(out.join("\n") + "\n");
    });
}
