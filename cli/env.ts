import { existsSync, readFileSync } from "node:fs";

// Minimal .env loader — the CLI's job is only to populate process.env, which is
// how core/* reads its keys (OPENAI_API_KEY, BRIGHTDATA_*, FIRECRAWL_API_KEY).
// No dotenv dependency: we own 15 lines instead of a package.

/**
 * Load KEY=VALUE lines from .env.local then .env. A variable already present
 * (real environment, or an earlier file) wins — so real env > .env.local > .env,
 * and secrets in the shell are never clobbered by a checked-in file.
 */
export function loadEnv(files = [".env.local", ".env"]): void {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue; // comment / blank / malformed → skip
      const key = m[1];
      if (key in process.env) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

/**
 * The message shown when a required LLM key is missing. Exported so it can be
 * tested: this text IS the remedy, and it used to point at a fix that didn't
 * work, which is worse than saying nothing.
 */
export function missingKeysMessage(missing: string[], models: string[] = []): string {
  // Which key you need is decided by which MODEL you chose, which is not
  // obvious from the key name alone — the default answer/judge model is an
  // OpenAI one, so a user holding only a Fireworks key gets told to set
  // OPENAI_API_KEY with no hint that picking a model is the real fix.
  //
  // The answer model and the judge default SEPARATELY, and both default to
  // OpenAI. So the old advice — "--model <provider>/<model>" — left the judge
  // on gpt-4o-mini and failed again with an identical error. Naming only one
  // flag sent Fireworks-only users in a circle.
  const because = models.length
    ? `\nNeeded because the answer/judge model is ${[...new Set(models)].join(" / ")}.\n` +
      `\nThe answer model and the judge are set separately and BOTH default to\n` +
      `OpenAI, so passing --model alone still fails on the judge. Point both at a\n` +
      `provider you have:\n` +
      `  --model fireworks/accounts/fireworks/models/kimi-k2p6 \\\n` +
      `  --judge fireworks/accounts/fireworks/models/deepseek-v4-pro\n` +
      `\nOr run \`sourcery init\` once to scaffold a config with your models, and\n` +
      `skip the flags entirely.\n`
    : "";
  return (
    `Missing required env: ${missing.join(", ")}\n` +
    `Set them in .env.local (see .env.example) or your shell.${because}`
  );
}

/**
 * Fail fast if a required key is missing. Only the LLM key is truly required
 * for a run (answer + judges) — provider keys degrade gracefully into a per-arm
 * error, so they're warned about, not enforced.
 */
export function requireKeys(names: string[], models: string[] = []): void {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (!missing.length) return;
  process.stderr.write(missingKeysMessage(missing, models));
  process.exit(1);
}
