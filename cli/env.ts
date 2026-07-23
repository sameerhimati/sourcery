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
 * Fail fast if a required key is missing. Only OPENAI_API_KEY is truly required
 * for a run (answer + judges) — provider keys degrade gracefully into a per-arm
 * error, so they're warned about, not enforced.
 */
export function requireKeys(names: string[]): void {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length) {
    process.stderr.write(
      `Missing required env: ${missing.join(", ")}\n` +
        `Set them in .env.local (see .env.example) or your shell.\n`,
    );
    process.exit(1);
  }
}
