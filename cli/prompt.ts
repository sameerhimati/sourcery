import { createInterface, type Interface } from "node:readline";

// Terminal prompts, hand-rolled. Three small functions against node:readline
// instead of a prompts/inquirer dependency: this is a published CLI, and every
// runtime dep is something a user installs to run one eval.

/** True when we can actually ask a human. */
export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function withReadline<T>(fn: (rl: Interface) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

/**
 * Ask before spending. Returns true to proceed.
 *
 * Auto-proceeds when stdin is not a TTY, so piping or CI is never left hanging
 * on a prompt nobody can answer. That is deliberately the LENIENT choice, and
 * it's safe only because `--max-credits` is the actual guard: a hard ceiling
 * that refuses without asking. This prompt is the courtesy on top of it.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const answer = await withReadline((rl) =>
    new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve)),
  );
  return /^y(es)?$/i.test(answer.trim());
}

/** Free-text answer. `fallback` is returned on an empty line. */
export async function ask(question: string, fallback = ""): Promise<string> {
  const answer = await withReadline((rl) =>
    new Promise<string>((resolve) => rl.question(question, resolve)),
  );
  return answer.trim() || fallback;
}

/**
 * Ask for a secret. Echo is suppressed so a key doesn't end up in the user's
 * scrollback or a screen recording — this is a tool whose whole setup is pasting
 * API keys, so they must not be left on screen.
 */
export async function askSecret(question: string): Promise<string> {
  if (!interactive()) return "";
  return withReadline(async (rl) => {
    // readline in terminal mode echoes each keystroke, and the OS echoes too if
    // we don't take over — so hiding input means overriding readline's private
    // writer. There is no public API for this and no dependency-free
    // alternative. Write the prompt exactly once, then swallow everything:
    // matching on the prompt text instead would re-print it on every keystroke
    // and break under backspace.
    const rlAny = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = rlAny._writeToOutput;
    let promptShown = false;
    rlAny._writeToOutput = () => {
      if (promptShown) return;
      promptShown = true;
      process.stdout.write(question);
    };
    try {
      const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
      process.stdout.write("\n");
      return answer.trim();
    } finally {
      rlAny._writeToOutput = original;
    }
  });
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Numbered single-select. Re-asks on an out-of-range answer. */
export async function select<T>(question: string, choices: Choice<T>[]): Promise<T> {
  process.stdout.write(`${question}\n`);
  choices.forEach((c, i) => {
    process.stdout.write(`  ${i + 1}) ${c.label}${c.hint ? `  — ${c.hint}` : ""}\n`);
  });
  for (;;) {
    const raw = await ask(`  [1-${choices.length}] `, "1");
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
    process.stdout.write(`  Pick a number from 1 to ${choices.length}.\n`);
  }
}

/** Numbered multi-select, comma-separated. Empty answer selects nothing. */
export async function multiSelect<T>(question: string, choices: Choice<T>[]): Promise<T[]> {
  process.stdout.write(`${question}\n`);
  choices.forEach((c, i) => {
    process.stdout.write(`  ${i + 1}) ${c.label}${c.hint ? `  — ${c.hint}` : ""}\n`);
  });
  for (;;) {
    const raw = await ask(`  [e.g. 1,3 — or blank for none] `);
    if (!raw) return [];
    const ns = raw.split(",").map((s) => Number(s.trim()));
    if (ns.every((n) => Number.isInteger(n) && n >= 1 && n <= choices.length)) {
      return [...new Set(ns)].map((n) => choices[n - 1].value);
    }
    process.stdout.write(`  Use numbers from 1 to ${choices.length}, comma-separated.\n`);
  }
}
