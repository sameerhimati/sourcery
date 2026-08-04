import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { defaultProviders, listAdapters, missingEnv } from "@core/adapters";
import { complete, PROVIDERS as LLM_PROVIDERS } from "@core/llm";
import { loadEnv } from "../env";
import { CONFIG_FILES } from "../config";
import { ask, askSecret, confirm, interactive, multiSelect, select } from "../prompt";

// ─── `sourcery init` ───
// This is the whole first impression, and it used to end by telling you to go
// edit two files by hand. Worse, it wrote `.env.example` while every doc says to
// fill in `.env.local`, so step one had a silent gap you had to infer.
//
// Now it asks, probes each key live, and writes a config naming the providers you
// actually hold — so `sourcery run` works immediately instead of after a round
// trip through the docs. It still degrades to the old non-interactive scaffold
// when there's no TTY, because `npx sourcery-eval init` inside a script must not
// hang on a question nobody can answer.

const ENV_FILE = ".env.local";

/**
 * Suggested answer/judge pairs per LLM backend, in the order they're offered.
 *
 * Groq leads because it is the shortest path from nothing to a scored result:
 * free tier, no credit card, and the fastest tokens/sec going, which is felt
 * directly here since every run is one answer call plus two judge calls.
 *
 * Llama 3.3 70B does both jobs rather than dropping to the 8B for speed. The
 * judge is not a place to economise, a weak one poisons every number downstream,
 * and its cutoff sits well before any query asking what is newest, which is
 * exactly what the anti-cheat wants. Groq also serves `openai/gpt-oss-*`, which
 * is deliberately not used: measured here, its answer scores ran ANTI-correlated
 * with a second judge at r = -0.50.
 */
const LLM_CHOICES = [
  {
    label: "Groq",
    value: "groq",
    hint: "free, no card, fastest — start here",
    model: "groq/llama-3.3-70b-versatile",
    judge: "groq/llama-3.3-70b-versatile",
  },
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
  {
    label: "Anthropic",
    value: "anthropic",
    hint: "Claude answers and judges (see the note on judges in the README)",
    // Both roles stay on Anthropic so this choice needs ONE key, like every
    // other. Claude is a current model, and the anti-cheat would rather the
    // judge's cutoff predated the queries, so this trades some answer-score
    // accuracy for a one-key setup. `--judge` overrides it, and a staler judge
    // is the better eval if you hold a second key.
    model: "anthropic/claude-haiku-4-5",
    judge: "anthropic/claude-haiku-4-5",
  },
] as const;

const ENV_HEADER = `# sourcery — written by \`sourcery init\`. Never commit this file.
`;

/**
 * A signup URL shortened to its host, for a menu line where the full URL would
 * wrap. `undefined` for the keyless baseline, which has nothing to sign up for.
 */
export function shortHost(url: string | undefined): string {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

/** Where to go and get the key you just failed to paste. */
function signupHint(backend: string): string {
  const where: Record<string, string> = {
    groq: "Free key, no card: https://console.groq.com/keys",
    fireworks: "Get one at https://app.fireworks.ai/settings/users/api-keys",
    openai: "Get one at https://platform.openai.com/api-keys",
    anthropic: "Get one at https://console.anthropic.com/settings/keys",
  };
  return where[backend] ?? "";
}

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
  // — the state a half-filled .env.local leaves keys in — and must be fillable.
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

/**
 * How to spell the command in copy-pasteable advice.
 *
 * The README leads with the clone, where the binary is not on PATH and the only
 * thing that works is `npm run sourcery -- run "…"`. Printing a bare `sourcery`
 * to that user hands them a command-not-found as the last thing the wizard says.
 * The tsx entrypoint is the tell: an installed copy runs `dist/index.js`.
 */
export function invocation(argv1: string = process.argv[1] ?? ""): string {
  return /cli[/\\]index\.ts$/.test(argv1) ? "npm run sourcery --" : "sourcery";
}

/**
 * The closing screen: what this tool has, in three lines.
 *
 * `init` used to end on a scorecard, which proves it works but leaves someone
 * who has never seen the CLI with no idea what else it does. These are the same
 * three commands the README leads with, in the same order.
 */
export function usageGuide(cmd: string = invocation()): string {
  return (
    `\nThree commands from here:\n` +
    `  ${cmd} run "<query>"   one query, every provider you have keys for\n` +
    `  ${cmd} batch           the built-in 48-query set — price it first with --dry-run\n` +
    `  ${cmd} report          self-contained HTML from everything you've run\n` +
    `\nConfig is ${CONFIG_FILES[0]}, keys are ${ENV_FILE}. Both are read from the\n` +
    `directory you run the command in.\n`
  );
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
    // The link goes ABOVE the prompt, not after a failed one. Someone who does
    // not have a key yet is the common case at this exact moment, and making
    // them submit an empty line to find out where to go is a puzzle, not a
    // wizard.
    process.stdout.write(`  ${signupHint(backend)}\n`);
    // Asked twice before giving up. A stray Enter used to end the whole wizard
    // with "re-run when you have one", which is a harsh price for a keypress.
    let key = await askSecret(`  Paste ${envKey}: `);
    if (!key) {
      process.stdout.write(`\n  Nothing entered. ${signupHint(backend)}\n`);
      key = await askSecret(`  Paste ${envKey} (or Enter to quit): `);
    }
    if (!key) {
      process.stdout.write(
        `\n  No key, so there's nothing to run yet. ${envKey} is required: every\n` +
          `  query needs a model to answer it and a model to grade it.\n` +
          `  Re-run \`sourcery init\` once you have one.\n`,
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
  // The hint answers the question actually being asked at this moment, which is
  // "where do I get one" — not "which env var will hold it". Naming the variable
  // helps only someone who already has the key.
  const menu = specs.map((s) => ({
    label: s.label,
    value: s.id,
    hint: missingEnv(s.id).length ? shortHost(s.signup) : "key already set",
  }));
  const question = "Which retrieval providers do you have keys for?  (the eval's actual variable)";
  let picked = await multiSelect(question, menu);

  // Selecting none used to sail straight through to a config whose only arm is
  // `plain`, which rate-limits within a couple of calls — so the wizard's grand
  // finale was "Winner: none (every provider failed)". Say so, and offer the
  // free one, before that happens rather than after.
  if (!picked.length) {
    const free = specs.find((s) => s.id === "tavily");
    process.stdout.write(
      `\n  Nothing picked. With no retrieval key the only arm is \`plain\`, the keyless\n` +
        `  baseline — it gets captcha'd almost immediately, so the first run would\n` +
        `  score nothing and tell you nothing.\n` +
        (free?.signup ? `  Tavily's free tier needs no card: ${free.signup}\n` : ""),
    );
    picked = await multiSelect("Pick one now, or leave blank to add keys later:", menu);
  }

  for (const id of picked) {
    const spec = specs.find((s) => s.id === id)!;
    // Same rule as the model key: say where to get it before asking for it.
    // Printed once per provider rather than once per variable, because Bright
    // Data's three values all come from the same page.
    const needs = spec.requiredEnv.filter((k) => !process.env[k]?.trim());
    if (needs.length && spec.signup) {
      process.stdout.write(`\n  ${spec.label} — get a key at ${spec.signup}\n`);
    }
    for (const key of needs) {
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
  // `ready` is already key-filtered, so this is here for the "at least two arms,
  // fall back to the keyless baseline" rule, which lives in one place now.
  const values = defaultProviders(ready);
  const config = writeConfig(chosen.model, chosen.judge, values);
  process.stdout.write("\n" + config.message + "\n");
  if (wrote.length) process.stdout.write(`  ✓ wrote ${ENV_FILE} (${wrote.join(", ")})\n`);
  if (kept.length) process.stdout.write(`  · kept existing ${kept.join(", ")}\n`);

  if (ready.length === 1) {
    process.stdout.write(
      `\n  One paid provider, so \`plain\` (the keyless baseline) is the other arm.\n` +
        `  It rate-limits hard — fine for seeing the tool work, not for a benchmark.\n` +
        `  A second key is where this starts comparing anything.\n`,
    );
  }

  // ─── 4. end by running something ───
  // The old init ended with "next: edit these files", which is where the "is
  // this a CLI or a dashboard?" confusion started. Finishing on a real result
  // makes what this thing is unambiguous.
  const cmd = invocation();

  // Unless there is nothing to run. With no retrieval key every arm is `plain`,
  // which gets captcha'd — offering the sample run there means ending setup on
  // "Winner: none (every provider failed)", which reads as a broken tool rather
  // than a missing key.
  if (!ready.length) {
    process.stdout.write(
      `\n  No retrieval key yet, so there's nothing to compare. Add one to ${ENV_FILE}\n` +
        `  (or re-run \`${cmd} init\`), then \`${cmd} providers --check\`.\n`,
    );
    process.stdout.write(usageGuide(cmd));
    return;
  }

  process.stdout.write(
    `\nReady:  ${cmd} run "<your query>"   — compares ${values.join(" vs ")}\n`,
  );
  if (await confirm("\nRun one now?")) {
    const query = await ask('  Query [what is the latest stable Node.js LTS?]: ',
      "what is the latest stable Node.js LTS?");
    process.stdout.write(`\n  ${cmd} run "${query}"\n`);
    const { runEval } = await import("@core/orchestrator");
    const { renderRun } = await import("../format");
    const run = await runEval({ query, variable: "provider", values, model: chosen.model, judge_model: chosen.judge });
    process.stdout.write("\n" + renderRun(run) + "\n");
  }

  // Printed whether or not they ran one. Declining the sample run is not a
  // reason to be left without the three commands the tool actually has.
  process.stdout.write(usageGuide(cmd));
}

/** The pre-wizard behaviour, kept for pipes and CI. */
/**
 * A blank `.env.local`, built from the registries rather than copied from
 * `.env.example`. The example file is not in the npm tarball (`files: ["dist"]`),
 * so a `npx sourcery-eval init` user was being sent to a file that does not
 * exist on their machine. Generating it also means a newly registered adapter
 * appears here for free instead of being forgotten.
 */
export function envTemplate(): string {
  const lines = [
    ENV_HEADER.trimEnd(),
    "",
    "# One LLM key, for the answer and judge steps. Set the one matching your models.",
    ...Object.values(LLM_PROVIDERS).map((p) => `${p.envKey}=`),
    "",
    "# Retrieval providers. Any you leave blank are simply skipped.",
  ];
  for (const spec of listAdapters()) {
    if (!spec.requiredEnv.length) continue;
    lines.push(`# ${spec.label} — ${spec.blurb}`, ...spec.requiredEnv.map((k) => `${k}=`), "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// The no-TTY path. It exists so `npx sourcery-eval init` inside a script cannot
// hang on a question nobody is there to answer, which is a real requirement.
//
// It used to meet that requirement by pretending to have succeeded: it wrote a
// config hardcoding Fireworks and `["firecrawl", "tavily"]` regardless of your
// keys, then told you to add keys to a .env.local it had not created. Someone
// holding only an Exa key got a config naming two providers they could not run.
// Now everything it writes follows the keys actually present, and it says
// plainly that the guided version needs a terminal.
function scaffold(): void {
  const out: string[] = ["Scaffolding sourcery (non-interactive):"];

  if (existsSync(ENV_FILE)) {
    out.push(`  · ${ENV_FILE} already exists, left alone`);
  } else {
    writeFileSync(ENV_FILE, envTemplate(), { mode: 0o600 });
    out.push(`  ✓ wrote ${ENV_FILE} — fill in the keys you have`);
  }

  // Models follow whichever LLM key is set, providers follow whichever
  // retrieval keys are set. Same rule the rest of the CLI now uses.
  const llm =
    LLM_CHOICES.find((c) => process.env[LLM_PROVIDERS[c.value].envKey]?.trim()) ?? LLM_CHOICES[0];
  out.push(writeConfig(llm.model, llm.judge, defaultProviders()).message);

  out.push("", "Retrieval providers:");
  for (const spec of listAdapters()) {
    const missing = missingEnv(spec.id);
    out.push(
      `  ${missing.length ? "·" : "✓"} ${spec.id}${missing.length ? ` — needs ${missing.join(", ")}` : ""}`,
    );
  }

  const cmd = invocation();
  out.push(
    "",
    `Next:  fill in ${ENV_FILE}, then \`${cmd} providers --check\``,
    "For the guided setup, which checks each key against its account, run",
    `\`${cmd} init\` in a terminal.`,
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
