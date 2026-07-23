import type { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { loadEnv } from "../env";
import { CONFIG_FILES } from "../config";

const CONFIG_TEMPLATE = `// sourcery config — plain ES module, edit freely.
// CLI flags override these; these override the engine's built-in defaults.
export default {
  // Answer + judge model (OpenAI). Judge defaults to gpt-4o-mini.
  model: "gpt-4o-mini",
  // Default comparison for \`sourcery run\`: vary the retrieval provider.
  variable: "provider",
  values: ["bright_data", "firecrawl"],
};
`;

const ENV_TEMPLATE = `# Copy to .env.local and fill in. sourcery reads these via process.env.
# Only OPENAI_API_KEY is strictly required — it powers the answer step and both
# judges. Missing a provider key just makes that provider's arm fail gracefully.

OPENAI_API_KEY=

BRIGHTDATA_API_TOKEN=
BRIGHTDATA_SERP_ZONE=sourcery_serp
BRIGHTDATA_UNLOCKER_ZONE=

FIRECRAWL_API_KEY=
`;

const KEYS: { name: string; required: boolean }[] = [
  { name: "OPENAI_API_KEY", required: true },
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
