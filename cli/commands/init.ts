import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { listAdapters, missingEnv } from "@core/adapters";
import { complete, PROVIDERS as LLM_PROVIDERS } from "@core/llm";
import { loadEnv } from "../env";
import { CONFIG_FILES } from "../config";
import { ask, askSecret, confirm, interactive, multiSelect, select } from "../prompt";

// ─── `sourcery init` ───
// This is the whole first impression, and it used to end by telling you to go
// edit two files by hand. Worse, it wrote `.env.example` while every doc says to
// fill in `.env.local`, so step one had a silent gap you had to infer.
//
// Now it asks, probes each key live, and writes a config naming the arms you
// actually hold — so `sourcery run` works immediately instead of after a round
// trip through the docs. It still degrades to the old non-interactive scaffold
// when there's no TTY, because `npx sourcery-eval init` inside a script must not
// hang on a question nobody can answer.

const ENV_FILE = ".env.local";

/** Suggested answer/judge pairs per LLM backend. */
const LLM_CHOICES = [
  {
    label: "Fireworks",
    value: "fireworks",
    hint: "open models, has the stale ones the anti-cheat wants",
    model: "fireworks/accounts/fireworks/models/kimi-k2p6",
    judge: "fireworks/accounts/fireworks/models/deepseek-v4-pro",
  },
  {
    label: "OpenAI",
    value: "openai",
    hint: "gpt-4o-mini answers and judges",
    model: "gpt-4o-mini",
    judge: "gpt-4o-mini",
  },
] as const;

const ENV_HEADER = `# sourcery — written by \`sourcery init\`. Never commit this file.
`;

/**
 * Merge keys into an existing .env.local body without disturbing anything
 * already there. Pure, and tested: this function can destroy the user's other
 * credentials, so "append only, never overwrite" needs to be provable rather
 * than merely intended.
 */
export function mergeEnv(
  existing: string,
  entries: Record<string, string>,
): { content: string; wrote: string[]; kept: string[] } {
  // Only a key with a non-empty value counts as present. `FOO=` is a placeholder
  // — the state Sameer's own OPENAI_API_KEY was in — and must be fillable.
  const present = new Set(
    existing
      .split("\n")
      .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => m[1]),
  );

  const wrote: string[] = [];
  const kept: string[] = [];
  let content = !existing || existing.endsWith("\n") ? existing : existing + "\n";
  for (const [key, value] of Object.entries(entries)) {
    if (!value) continue;
    // A key already holding a value is never overwritten — someone re-running
    // init to add one provider must not lose the others.
    if (present.has(key)) {
      kept.push(key);
      continue;
    }
    content += `${key}=${value}\n`;
    wrote.push(key);
  }
  return { content, wrote, kept };
}

function writeEnv(entries: Record<string, string>): { wrote: string[]; kept: string[] } {
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : ENV_HEADER;
  const { content, wrote, kept } = mergeEnv(existing, entries);
  // 0600: this file is nothing but credentials.
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
  return { wrote, kept };
}

function writeConfig(
  model: string,
  judge: string,
  values: string[],
): { message: string; written: boolean } {
  const file = CONFIG_FILES[0];
  // Never clobber a config the user may have edited. The caller needs to know,
  // because otherwise the wizard signs off by reporting arms that came from this
  // run while the file on disk says something else.
  if (existsSync(file)) {
    return { message: `  · ${file} already exists — left as is`, written: false };
  }
  writeFileSync(
    file,
    `// sourcery config — plain ES module, edit freely.
// CLI flags override these; these override the engine's built-in defaults.
export default {
  // Answer model. A "provider/model" ref picks the backend; a bare id
  // (e.g. "gpt-4o-mini") means OpenAI.
  model: ${JSON.stringify(model)},
  // Judge grades retrieval + answer. Set separately from \`model\` on purpose:
  // the anti-cheat wants a judge whose training cutoff predates the queries. A
  // fresher judge degrades only answer_score — retrieval_score, the primary
  // metric, is cutoff-independent.
  judge: ${JSON.stringify(judge)},
  // Default comparison for \`sourcery run\`: vary the retrieval provider.
  variable: "provider",
  // Written from the keys that answered a live probe during \`init\`.
  values: ${JSON.stringify(values)},
};
`,
  );
  return { message: `  ✓ wrote ${file}`, written: true };
}

/** One cheap completion — proves the key works, not merely that it is present. */
async function probeLlm(model: string): Promise<string | null> {
  try {
    await complete({ model, messages: [{ role: "user", content: "say ok" }] });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 160) : String(e);
  }
}

async function wizard(): Promise<void> {
  process.stdout.write(
    "\nsourcery init — three questions, then a working config.\n" +
      "Keys go to .env.local (chmod 600, gitignored) and are never printed back.\n\n",
  );

  // ─── 1. the LLM, which is the only hard requirement ───
  const backend = await select("Which LLM backend runs the answer + judge steps?", [
    ...LLM_CHOICES.map((c) => ({ label: c.label, value: c.value, hint: c.hint })),
  ]);
  const chosen = LLM_CHOICES.find((c) => c.value === backend)!;
  const envKey = LLM_PROVIDERS[backend].envKey;

  const env: Record<string, string> = {};
  if (process.env[envKey]?.trim()) {
    process.stdout.write(`  ${envKey} already set — using it.\n`);
  } else {
    const key = await askSecret(`  Paste ${envKey}: `);
    if (!key) {
      process.stdout.write(
        `\n  No key given. ${envKey} is required — every arm needs an answer and a\n` +
          `  judge. Re-run \`sourcery init\` when you have one.\n`,
      );
      return;
    }
    env[envKey] = key;
    process.env[envKey] = key;
  }

  process.stdout.write(`  Checking ${chosen.label}…`);
  const llmError = await probeLlm(chosen.model);
  process.stdout.write(
    llmError ? `  ✗\n  ${llmError}\n` : `  ✓ ${chosen.label} answered.\n`,
  );
  if (llmError && !(await confirm("  Continue anyway?"))) return;

  // ─── 2. retrieval providers ───
  process.stdout.write("\n");
  const specs = listAdapters().filter((s) => s.requiredEnv.length > 0);
  const picked = await multiSelect(
    "Which retrieval providers do you have keys for?  (the eval's actual variable)",
    specs.map((s) => ({
      label: s.label,
      value: s.id,
      hint: missingEnv(s.id).length ? `needs ${s.requiredEnv.join(", ")}` : "key already set",
    })),
  );

  for (const id of picked) {
    const spec = specs.find((s) => s.id === id)!;
    for (const key of spec.requiredEnv) {
      if (process.env[key]?.trim()) continue;
      const value = await askSecret(`  ${spec.label} — ${key}: `);
      if (value) {
        env[key] = value;
        process.env[key] = value;
      }
    }
  }

  const { wrote, kept } = writeEnv(env);

  // Probe AFTER writing, so a key that turns out to be exhausted is still saved
  // rather than lost to a failed check.
  process.stdout.write("\nChecking retrieval providers:\n");
  const ready: string[] = [];
  for (const id of picked) {
    const spec = specs.find((s) => s.id === id)!;
    const missing = missingEnv(id);
    if (missing.length) {
      process.stdout.write(`  ✗ ${spec.label} — still missing ${missing.join(", ")}\n`);
      continue;
    }
    // health() reports quota, which is the difference between "key is set" and
    // "this account will actually serve a run".
    const status = spec.health ? await spec.health().catch((e) => `check failed: ${e}`) : "key set";
    process.stdout.write(`  ✓ ${spec.label} — ${status}\n`);
    ready.push(id);
  }

  // ─── 3. write the config ───
  // `values` is the arms the user HAS. The old template hardcoded
  // bright_data + firecrawl, which is the worst possible first run: bright_data
  // needs three env vars and historically failed a quarter of its arms.
  const values = ready.length >= 2 ? ready : [...ready, "plain"];
  const config = writeConfig(chosen.model, chosen.judge, values);
  process.stdout.write("\n" + config.message + "\n");
  if (wrote.length) process.stdout.write(`  ✓ wrote ${ENV_FILE} (${wrote.join(", ")})\n`);
  if (kept.length) process.stdout.write(`  · kept existing ${kept.join(", ")}\n`);

  if (ready.length < 2) {
    process.stdout.write(
      `\n  Only ${ready.length} paid arm ready, so \`plain\` (the keyless baseline) is the\n` +
        `  other. It rate-limits hard — fine for trying the tool, not for a benchmark.\n`,
    );
  }

  // ─── 4. end by running something ───
  // The old init ended with "next: edit these files", which is where the "is
  // this a CLI or a dashboard?" confusion started. Finishing on a real result
  // makes what this thing is unambiguous.
  process.stdout.write(
    `\nReady:  sourcery run "<your query>"   — compares ${values.join(" vs ")}\n`,
  );
  if (!(await confirm("\nRun one now?"))) return;
  const query = await ask('  Query [what is the latest stable Node.js LTS?]: ',
    "what is the latest stable Node.js LTS?");
  process.stdout.write(`\n  sourcery run "${query}"\n`);
  const { runEval } = await import("@core/orchestrator");
  const { renderRun } = await import("../format");
  const run = await runEval({ query, variable: "provider", values, model: chosen.model, judge_model: chosen.judge });
  process.stdout.write("\n" + renderRun(run) + "\n");
}

/** The pre-wizard behaviour, kept for pipes and CI. */
function scaffold(): void {
  const out: string[] = ["Scaffolding sourcery (non-interactive):"];
  out.push(writeConfig(LLM_CHOICES[0].model, LLM_CHOICES[0].judge, ["firecrawl", "tavily"]).message);
  out.push("", "Keys detected:");
  for (const spec of listAdapters()) {
    const missing = missingEnv(spec.id);
    out.push(`  ${missing.length ? "·" : "✓"} ${spec.id}${missing.length ? ` — needs ${missing.join(", ")}` : ""}`);
  }
  out.push(
    "",
    `Add your keys to ${ENV_FILE}, then: sourcery run "<your query>"`,
    "Run in a terminal for the guided setup.",
  );
  process.stdout.write(out.join("\n") + "\n");
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Guided setup: pick models, add keys, verify them, write a config")
    .option("--no-interactive", "just scaffold the files, ask nothing")
    .action(async (opts: { interactive?: boolean }) => {
      loadEnv();
      if (opts.interactive === false || !interactive()) return scaffold();
      await wizard();
    });
}
