import { createInterface } from "node:readline";

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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question} [y/N] `, resolve),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
